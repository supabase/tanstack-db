import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type DeleteMutationFnParams,
  extractSimpleComparisons,
  type InsertMutationFnParams,
  type LoadSubsetOptions,
  parseLoadSubsetOptions,
  parseOrderByExpression,
  parseWhereExpression,
  type SimpleComparison,
  type UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"

type GenericPostgrestFilterBuilder = PostgrestFilterBuilder<any, any, any, any>

// Default range size used when an offset is requested without an explicit
// limit, matching the one-shot queryOnce path.
const DEFAULT_PAGE_SIZE = 1000

const buildQuery = (
  baseQuery: GenericPostgrestFilterBuilder,
  filter: SimpleComparison
): GenericPostgrestFilterBuilder => {
  const column = filter.field?.join(".")
  if (filter.operator === "eq") {
    return baseQuery.eq(column, filter.value)
  }
  if (filter.operator === "gt") {
    return baseQuery.gt(column, filter.value)
  }
  if (filter.operator === "gte") {
    return baseQuery.gte(column, filter.value)
  }
  if (filter.operator === "lt") {
    return baseQuery.lt(column, filter.value)
  }
  if (filter.operator === "lte") {
    return baseQuery.lte(column, filter.value)
  }
  if (filter.operator === "in") {
    return baseQuery.in(column, filter.value)
  }
  if (filter.operator === "isNull") {
    return baseQuery.is(column, null)
  }
  if (filter.operator === "not_eq") {
    return baseQuery.not(column, "eq", filter.value)
  }
  console.warn(`buildQuery: unsupported operator: ${filter.operator}`)
  return baseQuery
}

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
) => {
  const filters = parseWhereExpression(ctx.where, {
    handlers: {
      eq: (field, value) => {
        return `${field.join(".")}=eq.${value}`
      },
      or: (field, value) => {
        return `or(${field},${value})`
      },
      isNull: (field) => `${field.join(".")}=is.null`,
      in: (field, value) => {
        const uniqueValues = Array.from(new Set(value))
        return `${field.join(".")}=in.${uniqueValues}`
      },
      and: (...filters) => {
        return `${filters.map((filter) => filter).join("&")}`
      },
      gt: (field, value) => {
        return `${field.join(".")}=gt.${value}`
      },
      gte: (field, value) => {
        return `${field.join(".")}=gte.${value}`
      },
      lt: (field, value) => {
        return `${field.join(".")}=lt.${value}`
      },
      lte: (field, value) => {
        return `${field.join(".")}=lte.${value}`
      },
      // `not` receives the already-parsed inner clause (e.g. "active=eq.false").
      // Wrap it so a negated clause produces a distinct cache key from the
      // un-negated one instead of colliding with it.
      not: (inner) => `not(${inner})`,
    },
    onUnknownOperator: (operator, args) => {
      console.warn(`Unsupported operator: ${operator}`)
      return null
    },
  })

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

  let cursorFilters: SimpleComparison[] = []
  if (cursor) {
    cursorFilters = [...extractSimpleComparisons(cursor.whereFrom)]
  }
  // Parse the expressions into simple format
  const parsed = parseLoadSubsetOptions({ orderBy, limit, where })

  let baseQuery = supabase.from(tableName).select("*")

  if (parsed.limit) {
    baseQuery = baseQuery.limit(parsed.limit)
  }

  if (offset) {
    // range() is inclusive on both ends, so the end index is the offset plus
    // the page size minus one. Without an explicit limit, fall back to a
    // sensible default page size instead of a hard-coded window.
    const end = offset + (parsed.limit ?? DEFAULT_PAGE_SIZE) - 1
    baseQuery = baseQuery.range(offset, end)
  }
  if (parsed.sorts) {
    parsed.sorts.forEach((sort) => {
      baseQuery = baseQuery.order(sort.field.join("."), {
        ascending: sort.direction === "asc",
      })
    })
  }

  if (parsed.filters) {
    ;[...parsed.filters, ...cursorFilters].forEach((filter) => {
      baseQuery = buildQuery(baseQuery, filter)
    })
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
        supabase.from(tableName).update({
          ...original,
          ...changes,
        }),
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
        supabase.from(tableName).delete(),
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
