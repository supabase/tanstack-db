import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type DeleteMutationFnParams,
  extractSimpleComparisons,
  type InsertMutationFnParams,
  type LoadSubsetOptions,
  parseOrderByExpression,
  type SimpleComparison,
  type UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"
import {
  appendLimit,
  appendOffset,
  appendOrder,
  cursorToPostgrestParams,
  type PostgrestParam,
  paramsToKey,
  paramsToSearch,
  toPostgrestParams,
} from "./postgrest-filters"
import { postgrestRequest } from "./postgrest-request"

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
) => {
  const filters = paramsToKey(toPostgrestParams(ctx.where, { mergeIn: true }))

  const sorts = parseOrderByExpression(ctx.orderBy)
  const limit = ctx.limit

  const options: Record<string, string> = {}
  if (filters) {
    options["filters"] = filters
  }
  if (sorts.length > 0) {
    options["sorts"] = sorts
      .map((sort) => `${sort.field.join(".")}:${sort.direction}`)
      .join(",")
  }
  if (limit) {
    options["limit"] = limit.toString()
  }

  const result: any[] = [tableName]
  if (Object.keys(options).length > 0) {
    result.push(options)
  }
  return result
}

export const supabaseQueryFn = async (
  supabase: SupabaseClient,
  tableName: string,
  ctx: {
    client: QueryClient
    queryKey: readonly unknown[]
    signal: AbortSignal
    meta: QueryMeta | undefined
    pageParam?: unknown
    direction?: unknown
  }
) => {
  const { limit, orderBy, offset, where, cursor } =
    ctx.meta?.loadSubsetOptions || {}

  let cursorFilters: Array<SimpleComparison> = []
  if (cursor) {
    cursorFilters = [...extractSimpleComparisons(cursor.whereFrom)]
  }
  const sorts = parseOrderByExpression(orderBy)

  const params: PostgrestParam[] = [
    ...toPostgrestParams(where, { mergeIn: true }),
    ...cursorToPostgrestParams(cursorFilters),
  ]
  const search = new URLSearchParams()
  search.set("select", "*")
  for (const [key, value] of paramsToSearch(params)) {
    search.append(key, value)
  }

  appendOrder(
    search,
    sorts.map((sort) => ({
      column: sort.field.join("."),
      ascending: sort.direction === "asc",
    }))
  )
  if (limit) {
    appendLimit(search, limit)
  }
  if (offset) {
    appendOffset(search, offset)
  }

  const data = await postgrestRequest(supabase, tableName, {
    method: "GET",
    search,
  })
  return data || []
}

/** Build the `key.eq.value` params matching a row for update/delete. */
export type KeyParams = (item: any) => PostgrestParam[]

export const supabaseOnInsert = async (
  supabase: SupabaseClient,
  tableName: string,
  { transaction, collection }: InsertMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const search = new URLSearchParams()
      search.set("select", "*")
      const data = await postgrestRequest(supabase, tableName, {
        method: "POST",
        search,
        body: { ...mutation.modified },
        returnRows: true,
        single: true,
      })

      mutation.modified = data
      // The data has been inserted and confirmed by the server, so we can write it to the collection
      collection.utils.writeInsert(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnUpdate = async (
  supabase: SupabaseClient,
  tableName: string,
  keyParams: KeyParams,
  { transaction, collection }: UpdateMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { original, changes } = mutation
      const search = paramsToSearch(keyParams(original))
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
  keyParams: KeyParams,
  { transaction, collection }: DeleteMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      await postgrestRequest(supabase, tableName, {
        method: "DELETE",
        search: paramsToSearch(keyParams(mutation.original)),
      })

      // The data has been deleted and confirmed by the server, so we can write it to the collection
      collection.utils.writeDelete(collection.getKeyFromItem(mutation.original))
    })
  )

  return { refetch: false }
}
