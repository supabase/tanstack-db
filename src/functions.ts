import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
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
  applyPostgrestParams,
  paramsToKey,
  toPostgrestParams,
} from "./postgrest-filters"
import { CLIENT_INFO, CLIENT_INFO_HEADER } from "./request-headers"

type GenericPostgrestFilterBuilder = PostgrestFilterBuilder<any, any, any, any>

/** Cursor filters arrive pre-flattened as `SimpleComparison`, not as IR. */
const buildQuery = (
  baseQuery: GenericPostgrestFilterBuilder,
  filter: SimpleComparison
): GenericPostgrestFilterBuilder => {
  const field = filter.field.join(".")
  if (filter.operator === "eq") {
    return baseQuery.eq(field, filter.value)
  }
  if (filter.operator === "gt") {
    return baseQuery.gt(field, filter.value)
  }
  if (filter.operator === "gte") {
    return baseQuery.gte(field, filter.value)
  }
  if (filter.operator === "lt") {
    return baseQuery.lt(field, filter.value)
  }
  if (filter.operator === "lte") {
    return baseQuery.lte(field, filter.value)
  }
  if (filter.operator === "in") {
    return baseQuery.in(field, filter.value)
  }
  if (filter.operator === "isNull") {
    return baseQuery.is(field, null)
  }
  if (filter.operator === "not_eq") {
    return baseQuery.not(field, "eq", filter.value)
  }
  console.warn(`buildQuery: unsupported operator: ${filter.operator}`)
  return baseQuery
}

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

  let baseQuery: GenericPostgrestFilterBuilder = supabase
    .from(tableName)
    .select("*")
    .setHeader(CLIENT_INFO_HEADER, CLIENT_INFO)

  if (limit) {
    baseQuery = baseQuery.limit(limit)
  }

  if (offset) {
    baseQuery = baseQuery.range(offset, offset + 5)
  }
  for (const sort of sorts) {
    baseQuery = baseQuery.order(sort.field.join("."), {
      ascending: sort.direction === "asc",
    })
  }

  baseQuery = applyPostgrestParams(
    baseQuery,
    toPostgrestParams(where, { mergeIn: true })
  )
  for (const filter of cursorFilters) {
    baseQuery = buildQuery(baseQuery, filter)
  }

  const { data, error } = await baseQuery

  if (error) {
    throw error
  }
  return data || []
}

export const supabaseOnInsert = async (
  supabase: SupabaseClient,
  tableName: string,
  { transaction, collection }: InsertMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { data, error } = await supabase
        .from(tableName)
        .insert({
          ...mutation.modified,
        })
        .setHeader(CLIENT_INFO_HEADER, CLIENT_INFO)
        .select()
        .single()

      if (error) {
        throw error
      }
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
  filter: (
    query: PostgrestFilterBuilder<any, any, any, any, any, any, any>,
    item: any
  ) => PostgrestFilterBuilder<any, any, any, any, any, any, any>,
  { transaction, collection }: UpdateMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { original, changes } = mutation
      const { error, data } = await filter(
        supabase
          .from(tableName)
          .update({
            ...original,
            ...changes,
          })
          .setHeader(CLIENT_INFO_HEADER, CLIENT_INFO),
        mutation.original
      )
        .select()
        .single()

      if (error) {
        throw error
      }
      mutation.modified = data
      collection.utils.writeUpdate(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnDelete = async (
  supabase: SupabaseClient,
  tableName: string,
  filter: (
    query: PostgrestFilterBuilder<any, any, any, any>,
    item: any
  ) => PostgrestFilterBuilder<any, any, any, any>,
  { transaction, collection }: DeleteMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { error } = await filter(
        supabase
          .from(tableName)
          .delete()
          .setHeader(CLIENT_INFO_HEADER, CLIENT_INFO),
        mutation.original
      )

      if (error) {
        throw error
      }
      // The data has been deleted and confirmed by the server, so we can write it to the collection
      collection.utils.writeDelete(collection.getKeyFromItem(mutation.original))
    })
  )

  return { refetch: false }
}
