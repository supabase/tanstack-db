/* biome-ignore-all lint/suspicious/noExplicitAny: collection items are typed by the caller's schema, not statically known here */
import type { StandardSchemaV1 } from "@standard-schema/spec"
import {
  REALTIME_SUBSCRIBE_STATES,
  type SupabaseClient,
} from "@supabase/supabase-js"
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
import { realtimeFiltersToSearch } from "./postgrest-filters"
import { getQueryClient } from "./query-client"
import { attachSupabaseListeners } from "./realtime"

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
  /**
   * Whether to push each query's WHERE clause to the Realtime subscription as a
   * server-side `postgres_changes` filter. Only applies when `realtime` is on.
   * Defaults to `false`, which subscribes to every change on the table and
   * filters client-side — simpler, at the cost of more Realtime traffic. Set to
   * `true` to narrow the subscription server-side.
   */
  realtimeUseFilter?: boolean
  /** The schema of the collection */
  schema: TSchema
  /** The supabase browser client */
  supabase: SupabaseClient
  /** The name of the table in the database */
  tableName: string
}

interface TableEntry {
  collectionRef: Collection<any, any> | null
  /** The joined channel currently delivering changes (null when none). */
  realtimeChannel: ReturnType<SupabaseClient["channel"]> | null
  /** Serialized set of Realtime filters the current channel was subscribed with */
  realtimeFiltersKey: string | null
  /**
   * A replacement channel that is still subscribing and has not joined yet. It
   * is tracked separately from {@link realtimeChannel} so an in-flight swap can
   * be superseded or torn down without losing the channel that is still
   * delivering changes.
   */
  realtimePendingChannel: ReturnType<SupabaseClient["channel"]> | null
  /** Serialized set of Realtime filters {@link realtimePendingChannel} is subscribing with */
  realtimePendingFiltersKey: string | null
  /** Resolves once the pending channel finished subscribing (or gave up) */
  realtimeSubscribed: Promise<void> | null
  /**
   * Whether WHERE clauses are pushed to Realtime as server-side filters. When
   * `false`, the table always subscribes with a catch-all and filters
   * client-side.
   */
  realtimeUseFilter: boolean
  /**
   * Filter sets the server has rejected. They are replaced by a catch-all
   * subscription instead of being retried on every observer change.
   */
  rejectedFilterKeys: Set<string>
  supabase: SupabaseClient
}

/** A subscription that receives every change for the table. */
const CATCH_ALL_FILTERS = [new URLSearchParams()]
const realtimeFiltersKey = (filters: URLSearchParams[]) =>
  JSON.stringify(filters.map((filter) => Array.from(filter)))
const CATCH_ALL_FILTERS_KEY = realtimeFiltersKey(CATCH_ALL_FILTERS)

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
 * Opens a channel for `filters` as the table's *pending* channel. The joined
 * channel keeps listening until the replacement actually joins, so no change
 * slips through while the swap is in flight; only then is the predecessor
 * removed. A swap already in flight is superseded (and torn down) first.
 *
 * On a terminal failure the pending channel is disposed. A filter the server
 * rejects is remembered and retried as a catch-all, while the previous channel
 * keeps working. A `CHANNEL_ERROR` on the catch-all itself is treated as a
 * transient connection error, not a rejection: if a previous channel is still
 * working it is kept, otherwise the errored channel is retained so realtime-js
 * reconnects it instead of leaving the table with no subscription at all.
 */
const subscribeToChanges = (
  entry: TableEntry,
  tableName: string,
  collection: Collection<any, any>,
  filters: URLSearchParams[],
  filtersKey: string
) => {
  const previousChannel = entry.realtimeChannel
  const previousFiltersKey = entry.realtimeFiltersKey

  // A swap already in flight is now stale: tear it down before opening the next
  // so a superseded replacement never leaks.
  if (entry.realtimePendingChannel) {
    entry.supabase.removeChannel(entry.realtimePendingChannel)
    entry.realtimePendingChannel = null
    entry.realtimePendingFiltersKey = null
  }

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

  entry.realtimePendingChannel = subscription.channel
  entry.realtimePendingFiltersKey = filtersKey
  entry.realtimeSubscribed = subscription.ready

  // True once a newer swap (or a teardown) has taken over this pending channel.
  const superseded = () => entry.realtimePendingChannel !== subscription.channel

  const onJoined = () => {
    if (superseded()) {
      return
    }
    if (previousChannel) {
      entry.supabase.removeChannel(previousChannel)
    }
    entry.realtimeChannel = subscription.channel
    entry.realtimeFiltersKey = filtersKey
    entry.realtimePendingChannel = null
    entry.realtimePendingFiltersKey = null
  }

  const onError = () => {
    if (superseded()) {
      entry.supabase.removeChannel(subscription.channel)
      return
    }
    entry.realtimePendingChannel = null
    entry.realtimePendingFiltersKey = null
    entry.realtimeSubscribed = null

    if (filtersKey !== CATCH_ALL_FILTERS_KEY) {
      // A filtered subscription the server refused: drop it, remember it, and
      // fall back to a catch-all while the previous channel keeps working.
      entry.supabase.removeChannel(subscription.channel)
      entry.rejectedFilterKeys.add(filtersKey)
      subscribeToChanges(
        entry,
        tableName,
        collection,
        CATCH_ALL_FILTERS,
        CATCH_ALL_FILTERS_KEY
      )
      return
    }

    // A catch-all has nothing to reject, so CHANNEL_ERROR here is a transient
    // connection error rather than a filter rejection.
    if (previousChannel) {
      // A previous channel is still delivering changes: drop the failed
      // catch-all and hand the swap back to the predecessor.
      entry.supabase.removeChannel(subscription.channel)
      entry.realtimeChannel = previousChannel
      entry.realtimeFiltersKey = previousFiltersKey
      return
    }
    // Nothing else is subscribed: keep the errored channel so realtime-js
    // reconnects it (its listeners stay attached) instead of leaving the table
    // with no subscription until an observer changes.
    entry.realtimeChannel = subscription.channel
    entry.realtimeFiltersKey = filtersKey
  }

  const onClosed = () => {
    // A terminal close before joining will not reconnect: drop it and hand the
    // swap back to the still-open previous channel.
    if (superseded()) {
      entry.supabase.removeChannel(subscription.channel)
      return
    }
    entry.supabase.removeChannel(subscription.channel)
    entry.realtimeChannel = previousChannel
    entry.realtimeFiltersKey = previousFiltersKey
    entry.realtimePendingChannel = null
    entry.realtimePendingFiltersKey = null
    entry.realtimeSubscribed = null
  }

  subscription.outcome.then((status) => {
    if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
      onJoined()
    } else if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR) {
      onError()
    } else {
      onClosed()
    }
  })
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

      // No active queries: tear down any existing subscription, including a swap
      // still in flight, so neither the joined nor the pending channel leaks.
      if (queries.length === 0) {
        if (entry.realtimeChannel) {
          entry.supabase.removeChannel(entry.realtimeChannel)
        }
        if (entry.realtimePendingChannel) {
          entry.supabase.removeChannel(entry.realtimePendingChannel)
        }
        entry.realtimeChannel = null
        entry.realtimeFiltersKey = null
        entry.realtimePendingChannel = null
        entry.realtimePendingFiltersKey = null
        entry.realtimeSubscribed = null
        continue
      }

      if (!entry.collectionRef) {
        continue
      }

      // Derive the Realtime filters from the WHERE clause of every active query
      // so the subscription only receives changes that those queries care about.
      // When server-side filtering is disabled, skip that entirely and subscribe
      // to every change on the table instead.
      let filters = CATCH_ALL_FILTERS
      let filtersKey = CATCH_ALL_FILTERS_KEY
      if (entry.realtimeUseFilter) {
        const whereExpressions = queries.map(
          (query) => query.meta?.loadSubsetOptions?.where
        )
        filters = realtimeFiltersToSearch(whereExpressions)
        filtersKey = realtimeFiltersKey(filters)
        if (entry.rejectedFilterKeys.has(filtersKey)) {
          filters = CATCH_ALL_FILTERS
          filtersKey = CATCH_ALL_FILTERS_KEY
        }
      }

      // Reuse the existing subscription when the set of filters hasn't changed.
      // While a swap is in flight the pending channel already targets the new
      // filters, so compare against it to avoid firing the same swap twice.
      const currentFiltersKey = entry.realtimePendingChannel
        ? entry.realtimePendingFiltersKey
        : entry.realtimeFiltersKey
      if (
        (entry.realtimeChannel || entry.realtimePendingChannel) &&
        currentFiltersKey === filtersKey
      ) {
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
  supabase: SupabaseClient,
  realtimeUseFilter: boolean
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
      realtimePendingChannel: null,
      realtimePendingFiltersKey: null,
      realtimeSubscribed: null,
      rejectedFilterKeys: new Set(),
      realtimeUseFilter,
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
  realtimeUseFilter = false,
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
    entry = registerTable(queryClient, tableName, supabase, realtimeUseFilter)
  }
  const config = queryCollectionOptions({
    id: tableName,
    queryClient,
    getKey,
    schema,
    queryKey: (ctx) => subsetOptionsToQueryKey(tableName, ctx),
    syncMode: "on-demand",
    queryFn: async (ctx) => {
      // Known limitation: the initial fetch does not wait for the Realtime
      // channel to finish subscribing. A row written in the window between this
      // fetch and the subscription going live can be missed by both — the fetch
      // ran before the row existed, and the subscription started after the
      // change was published. Gating the fetch on `entry.realtimeSubscribed`
      // closes this gap but couples every first load to Realtime connect
      // latency, so it is intentionally left out and tracked separately.
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
