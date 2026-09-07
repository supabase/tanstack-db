/* biome-ignore-all lint/suspicious/noExplicitAny: collection items are typed by the caller's schema, not statically known here */
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SupabaseClient } from "@supabase/supabase-js"
import { BasicIndex, type Collection } from "@tanstack/db"
import type { QueryClient } from "@tanstack/query-core"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import {
  subsetOptionsToQueryKey,
  supabaseOnDelete,
  supabaseOnInsert,
  supabaseOnUpdate,
  supabaseQueryFn,
} from "./functions"
import { getQueryClient } from "./query-client"
import { attachSupabaseListeners, buildRealtimeFilters } from "./realtime"

interface SupabaseCollectionOptions<TSchema extends StandardSchemaV1> {
  /**
   * The columns that uniquely identify a row. Used to extract the key for
   * storing the item in the collection and to build the where clause for
   * update and delete operations.
   */
  keys: Array<keyof StandardSchemaV1.InferOutput<TSchema> & string>
  /** The query client */
  queryClient?: QueryClient
  /** Whether to receive updates when a record has been inserted, updated, or deleted by another user */
  realtime?: boolean
  /** The schema of the collection */
  schema: TSchema
  /** The supabase browser client */
  supabase: SupabaseClient
  /** The name of the table in the database */
  tableName: string
}

interface TableEntry {
  collectionRef: Collection<any, any> | null
  realtimeChannel: ReturnType<SupabaseClient["channel"]> | null
  /** Serialized set of Realtime filters the current channel was subscribed with */
  realtimeFiltersKey: string | null
  /** Resolves once the current channel finished subscribing (or gave up) */
  realtimeSubscribed: Promise<void> | null
  /**
   * Filter sets the server has rejected. They are replaced by a catch-all
   * subscription instead of being retried on every observer change.
   */
  rejectedFilterKeys: Set<string>
  supabase: SupabaseClient
}

/** A subscription that receives every change for the table. */
const CATCH_ALL_FILTERS: Array<string | null> = [null]
const CATCH_ALL_FILTERS_KEY = JSON.stringify(CATCH_ALL_FILTERS)

/**
 * Channel topics are namespaced and numbered because `supabase.channel()`
 * returns the *existing* channel for a topic that is already registered, and
 * subscribing to an already-joined channel throws. Reusing the table name would
 * hand back the channel currently being torn down, and could collide with a
 * channel the application opened itself or with another QueryClient sharing the
 * same Supabase client — so the counter is module-level, not per table.
 */
let channelCount = 0

/**
 * Every channel this adapter opens for `tableName` has a topic starting with
 * this prefix (supabase-js exposes it under its own `realtime:` prefix).
 */
export const realtimeChannelTopicPrefix = (tableName: string) =>
  `supabase-tanstack-db:${tableName}:`

const nextChannelTopic = (tableName: string) => {
  channelCount += 1
  return `${realtimeChannelTopicPrefix(tableName)}${channelCount}`
}

/**
 * Opens a channel for `filters` and makes it the table's current channel. The
 * previous channel keeps listening until the replacement is actually joined,
 * so no change slips through while the swap is in flight. If the server
 * rejects the new subscription, the previous channel stays in place and a
 * catch-all subscription is attempted instead of losing Realtime entirely.
 */
const subscribeToChanges = (
  entry: TableEntry,
  tableName: string,
  collection: Collection<any, any>,
  filters: Array<string | null>,
  filtersKey: string
) => {
  const previousChannel = entry.realtimeChannel
  const previousFiltersKey = entry.realtimeFiltersKey

  const subscription = attachSupabaseListeners(
    entry.supabase,
    nextChannelTopic(tableName),
    tableName,
    collection,
    filters
  )
  if (!subscription) {
    if (previousChannel) {
      entry.supabase.removeChannel(previousChannel)
    }
    entry.realtimeChannel = null
    entry.realtimeFiltersKey = null
    entry.realtimeSubscribed = null
    return
  }

  entry.realtimeChannel = subscription.channel
  entry.realtimeFiltersKey = filtersKey
  entry.realtimeSubscribed = subscription.ready

  const onJoined = () => {
    if (previousChannel) {
      entry.supabase.removeChannel(previousChannel)
    }
  }

  const onRejected = () => {
    entry.supabase.removeChannel(subscription.channel)
    if (entry.realtimeChannel !== subscription.channel) {
      // A newer subscription has already taken over the swap.
      return
    }
    // Hand the swap back to the still-open previous channel, so whatever is
    // tried next treats it as its predecessor.
    entry.realtimeChannel = previousChannel
    entry.realtimeFiltersKey = previousFiltersKey
    entry.realtimeSubscribed = null
    if (filtersKey === CATCH_ALL_FILTERS_KEY) {
      // Even the unfiltered subscription was refused: Realtime is unusable for
      // this table right now. The next observer change will try again.
      return
    }
    entry.rejectedFilterKeys.add(filtersKey)
    subscribeToChanges(
      entry,
      tableName,
      collection,
      CATCH_ALL_FILTERS,
      CATCH_ALL_FILTERS_KEY
    )
  }

  subscription.joined.then((joined) => (joined ? onJoined() : onRejected()))
}

// Per-QueryClient registry of table entries, with a single cache subscription per client
const queryClientRegistries = new Map<QueryClient, Map<string, TableEntry>>()

const ensureQueryCacheSubscription = (queryClient: QueryClient) => {
  if (queryClientRegistries.has(queryClient)) {
    return
  }

  const tables = new Map<string, TableEntry>()
  queryClientRegistries.set(queryClient, tables)

  queryClient.getQueryCache().subscribe((args) => {
    if (args.type !== "observerAdded" && args.type !== "observerRemoved") {
      return
    }
    for (const [tableName, entry] of tables) {
      const queries = queryClient.getQueryCache().findAll({
        queryKey: [tableName],
        type: "active",
      })

      // No active queries: tear down any existing subscription.
      if (queries.length === 0) {
        if (entry.realtimeChannel) {
          entry.supabase.removeChannel(entry.realtimeChannel)
          entry.realtimeChannel = null
          entry.realtimeFiltersKey = null
          entry.realtimeSubscribed = null
        }
        continue
      }

      if (!entry.collectionRef) {
        continue
      }

      // Derive the Realtime filters from the WHERE clause of every active query
      // so the subscription only receives changes that those queries care about.
      const whereExpressions = queries.map(
        (query) => query.meta?.loadSubsetOptions?.where
      )
      let filters = buildRealtimeFilters(whereExpressions)
      let filtersKey = JSON.stringify(filters)
      if (entry.rejectedFilterKeys.has(filtersKey)) {
        filters = CATCH_ALL_FILTERS
        filtersKey = CATCH_ALL_FILTERS_KEY
      }

      // Reuse the existing channel when the set of filters hasn't changed.
      if (entry.realtimeChannel && entry.realtimeFiltersKey === filtersKey) {
        continue
      }

      // Filters changed (or no channel yet): subscribe with the new filters.
      subscribeToChanges(
        entry,
        tableName,
        entry.collectionRef,
        filters,
        filtersKey
      )
    }
  })
}

const registerTable = (
  queryClient: QueryClient,
  tableName: string,
  supabase: SupabaseClient
): TableEntry => {
  ensureQueryCacheSubscription(queryClient)
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  const tables = queryClientRegistries.get(queryClient)!

  if (!tables.has(tableName)) {
    tables.set(tableName, {
      supabase,
      collectionRef: null,
      realtimeChannel: null,
      realtimeFiltersKey: null,
      realtimeSubscribed: null,
      rejectedFilterKeys: new Set(),
    })
  }

  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  return tables.get(tableName)!
}

export const supabaseCollectionOptions = <TSchema extends StandardSchemaV1>({
  tableName,
  keys,
  schema,
  queryClient,
  supabase,
  realtime,
}: SupabaseCollectionOptions<TSchema>) => {
  // if the query client is not provided, use the global query client
  queryClient = queryClient ?? getQueryClient()

  type TItem = StandardSchemaV1.InferOutput<TSchema>

  // Derive the collection key from the configured key columns. A single key
  // column is used as-is, while composite keys are joined into a string.
  const getKey = (item: TItem): string | number => {
    return keys.map((key) => item[key]).join("-")
  }

  // Key columns used to match rows on update and delete.
  const keyColumns = keys as string[]

  let entry: TableEntry | null = null
  if (realtime) {
    entry = registerTable(queryClient, tableName, supabase)
  }
  const config = queryCollectionOptions({
    id: tableName,
    queryClient,
    getKey,
    schema,
    queryKey: (ctx) => subsetOptionsToQueryKey(tableName, ctx),
    syncMode: "on-demand",
    queryFn: async (ctx) => {
      // The channel is attached when the query's observer is added, which
      // happens before this runs. Waiting for it means a row written between
      // the fetch and the subscription arrives over Realtime instead of being
      // missed by both.
      if (entry?.realtimeSubscribed) {
        await entry.realtimeSubscribed
      }
      return await supabaseQueryFn(supabase, tableName, ctx)
    },
    onInsert: (ctx) => supabaseOnInsert(supabase, tableName, ctx),
    onUpdate: (ctx) => supabaseOnUpdate(supabase, tableName, keyColumns, ctx),
    onDelete: (ctx) => supabaseOnDelete(supabase, tableName, keyColumns, ctx),
    autoIndex: "eager",
    defaultIndexType: BasicIndex,
  })

  const originalSync = config.sync.sync

  return {
    ...config,
    sync: {
      sync: (
        ...args: Parameters<typeof originalSync>
      ): ReturnType<typeof originalSync> => {
        if (entry) {
          entry.collectionRef = args[0].collection as Collection<any, any>
        }
        return originalSync(...args)
      },
    },
  }
}
