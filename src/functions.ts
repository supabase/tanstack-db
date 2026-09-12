import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type DeleteMutationFnParams,
  type InsertMutationFnParams,
  type LoadSubsetOptions,
  parseOrderByExpression,
  type UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"
import {
  keyColumnsToSearch,
  loadSubsetOptionsToSearch,
  subsetParamsToSearch,
} from "./postgrest-filters"
import { appendOrder } from "./postgrest-filters/common"
import { postgrestRequest } from "./postgrest-request"
import { isSynced } from "./realtime"

export const DEFAULT_PAGE_SIZE = 1000

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
): Array<string> => {
  // The key shares the request URL's where/order/limit encoding
  // (`subsetParamsToSearch`) so the two cannot drift. Pagination params
  // (cursor/offset) and the constant `select` are intentionally excluded:
  // pages of one subset must share a cache key. The collection's fixed key
  // columns are added as request-order tie-breakers, not subset identity.
  const key = subsetParamsToSearch(ctx).toString()
  return key ? [tableName, key] : [tableName]
}

export const supabaseQueryFn = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  ctx: {
    client: QueryClient
    queryKey: readonly unknown[]
    signal: AbortSignal
    meta: QueryMeta | undefined
    pageParam?: unknown
    direction?: unknown
  },
  pageSize = DEFAULT_PAGE_SIZE
) => {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer")
  }

  const options = ctx.meta?.loadSubsetOptions ?? {}
  const { limit, offset } = options
  if (limit === 0) {
    return []
  }

  const search = loadSubsetOptionsToSearch(options)
  const sorts = parseOrderByExpression(options.orderBy).map((sort) => ({
    column: sort.field.join("."),
    ascending: sort.direction === "asc",
  }))
  // Offset pagination needs a unique order even when the caller omits a sort
  // or sorts by a non-unique column. Preserve explicit key sort directions.
  for (const key of keys) {
    if (!sorts.some((sort) => sort.column === key)) {
      sorts.push({ column: key, ascending: true })
    }
  }
  appendOrder(search, sorts)

  const rows: any[] = []
  let pageOffset = offset ?? 0

  while (limit === undefined || rows.length < limit) {
    const remaining = limit === undefined ? pageSize : limit - rows.length
    const currentPageSize = Math.min(pageSize, remaining)
    search.set("limit", String(currentPageSize))
    if (pageOffset !== 0) {
      search.set("offset", String(pageOffset))
    }

    const data = await postgrestRequest(supabase, tableName, {
      method: "GET",
      search,
    })
    const page = data || []
    rows.push(...page)

    if (page.length < currentPageSize) {
      break
    }
    pageOffset += currentPageSize
  }

  return rows
}

export const supabaseOnInsert = async (
  supabase: SupabaseClient,
  tableName: string,
  { transaction, collection }: InsertMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const data = await postgrestRequest(supabase, tableName, {
        method: "POST",
        search: new URLSearchParams({ select: "*" }),
        body: { ...mutation.modified },
        returnRows: true,
        single: true,
      })

      mutation.modified = data
      // The data has been inserted and confirmed by the server, so we can write
      // it to the collection. Realtime may already have echoed the insert, in
      // which case this is an update of the synced row rather than an insert.
      collection.utils.writeUpsert(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnUpdate = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  { transaction, collection }: UpdateMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { original, changes } = mutation
      const search = keyColumnsToSearch(keys, original)
      search.set("select", "*")
      const data = await postgrestRequest(supabase, tableName, {
        method: "PATCH",
        search,
        body: { ...original, ...changes },
        returnRows: true,
        single: true,
      })

      mutation.modified = data
      collection.utils.writeUpdate(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnDelete = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  { transaction, collection }: DeleteMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      await postgrestRequest(supabase, tableName, {
        method: "DELETE",
        search: keyColumnsToSearch(keys, mutation.original),
      })

      // The data has been deleted and confirmed by the server, so we can write
      // it to the collection — unless Realtime already echoed the delete, in
      // which case the synced row is gone and writing again would throw.
      const key = collection.getKeyFromItem(mutation.original)
      if (isSynced(collection, key)) {
        collection.utils.writeDelete(key)
      }
    })
  )

  return { refetch: false }
}
