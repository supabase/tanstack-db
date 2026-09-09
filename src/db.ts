/* biome-ignore-all lint/suspicious/noExplicitAny: collection items are typed by the caller's schema, not statically known here */
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SupabaseClient } from "@supabase/supabase-js"
import { BasicIndex, type Collection } from "@tanstack/db"
import type { QueryClient } from "@tanstack/query-core"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import {
  DEFAULT_PAGE_SIZE,
  subsetOptionsToQueryKey,
  supabaseOnDelete,
  supabaseOnInsert,
  supabaseOnUpdate,
  supabaseQueryFn,
} from "./functions"
import { getQueryClient } from "./query-client"
import { syncTableSubscription, type TableEntry } from "./realtime"

interface SupabaseCollectionOptions<TSchema extends StandardSchemaV1> {
  /**
   * The columns that uniquely identify a row. Used to extract the key for
   * storing the item in the collection and to build the where clause for
   * update and delete operations.
   */
  keys: Array<keyof StandardSchemaV1.InferOutput<TSchema> & string>
  /** Maximum number of rows requested from PostgREST at a time */
  pageSize?: number
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
      syncTableSubscription(queryClient, tableName, entry)
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
  pageSize = DEFAULT_PAGE_SIZE,
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

  // A server-side Supabase client has no `channel`, so Realtime is a no-op there
  // and the table is never registered. Checking here keeps attachSupabaseListeners
  // able to always return a live subscription.
  let entry: TableEntry | null = null
  if (realtime && typeof supabase.channel === "function") {
    entry = registerTable(queryClient, tableName, supabase, realtimeUseFilter)
  }
  const config = queryCollectionOptions({
    id: tableName,
    queryClient,
    getKey,
    schema,
    queryKey: (ctx) => subsetOptionsToQueryKey(tableName, ctx),
    syncMode: "on-demand",
    // Known limitation: the initial fetch does not wait for the Realtime channel
    // to finish subscribing. A row written in the window between this fetch and
    // the subscription going live can be missed by both — the fetch ran before
    // the row existed, and the subscription started after the change was
    // published. Gating the fetch on the subscription closes this gap but couples
    // every first load to Realtime connect latency, so it is intentionally left
    // out and tracked separately.
    queryFn: (ctx) => supabaseQueryFn(supabase, tableName, ctx, pageSize),
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
