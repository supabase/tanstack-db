/* biome-ignore-all lint/suspicious/noExplicitAny: PostgrestFilterBuilder requires database schema types which are not available without codegen */
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
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

type GenericPostgrestFilterBuilder = PostgrestFilterBuilder<any, any, any, any>

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
  supabase: SupabaseClient
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

      if (queries.length > 0 && !entry.realtimeChannel && entry.collectionRef) {
        entry.realtimeChannel = attachSupabaseListeners(
          entry.supabase,
          tableName,
          entry.collectionRef
        )
      } else if (queries.length === 0 && entry.realtimeChannel) {
        entry.supabase.removeChannel(entry.realtimeChannel)
        entry.realtimeChannel = null
      }
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

  // Build the where clause for update and delete operations by matching every
  // configured key column against the item's values.
  const where = (
    query: GenericPostgrestFilterBuilder,
    item: TItem
  ): GenericPostgrestFilterBuilder => {
    let scopedQuery = query
    for (const key of keys) {
      scopedQuery = scopedQuery.eq(key as string, item[key])
    }
    return scopedQuery
  }

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
    queryFn: (ctx) => supabaseQueryFn(supabase, tableName, ctx),
    onInsert: (ctx) => supabaseOnInsert(supabase, tableName, ctx),
    onUpdate: (ctx) => supabaseOnUpdate(supabase, tableName, where, ctx),
    onDelete: (ctx) => supabaseOnDelete(supabase, tableName, where, ctx),
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

export const attachSupabaseListeners = <
  T extends object,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  tableName: string,
  collection: Collection<T, TKey>
): ReturnType<SupabaseClient["channel"]> | null => {
  if (!supabase.channel) {
    console.log("Server supabase doesn't have a channel")
    return null
  }

  const channel = supabase.channel(tableName)
  channel
    .on<T>(
      "postgres_changes",
      { event: "*", schema: "public", table: tableName },
      (payload) => {
        if (payload.eventType === "INSERT") {
          collection.utils.writeInsert(payload.new)
        } else if (payload.eventType === "UPDATE") {
          collection.utils.writeUpdate(payload.new)
        } else if (payload.eventType === "DELETE") {
          const id = collection.getKeyFromItem(payload.old as T)
          if (collection.has(id)) {
            collection.utils.writeDelete(id)
          }
        }
      }
    )
    .subscribe()

  return channel
}
