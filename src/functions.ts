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

/** `not(...)` comparisons reach us as the operator with this prefix. */
const NEGATION_PREFIX = "not_"

/** Comparison operators that map onto a PostgREST filter of the same name. */
const COMPARISON_OPERATORS = new Set(["eq", "gt", "gte", "lt", "lte"])

/**
 * postgrest-js interpolates filter values into the URL as-is, and
 * `Date.prototype.toString()` produces something Postgres cannot cast to a
 * timestamp. Rendering it the same way the Realtime filters do keeps the
 * server query and the subscription in agreement.
 */
const toFilterValue = (value: unknown) =>
  value instanceof Date ? value.toISOString() : value

const applyComparison = (
  baseQuery: PostgrestFilterBuilder<any, any, any, any>,
  column: string,
  operator: string,
  value: unknown
) => {
  if (operator === "gt") {
    return baseQuery.gt(column, value)
  }
  if (operator === "gte") {
    return baseQuery.gte(column, value)
  }
  if (operator === "lt") {
    return baseQuery.lt(column, value)
  }
  if (operator === "lte") {
    return baseQuery.lte(column, value)
  }
  return baseQuery.eq(column, value)
}

const buildQuery = (
  baseQuery: PostgrestFilterBuilder<any, any, any, any>,
  filter: SimpleComparison
) => {
  const column = filter.field?.join(".")
  if (!column) {
    return baseQuery
  }

  const negated = filter.operator.startsWith(NEGATION_PREFIX)
  const operator = negated
    ? filter.operator.slice(NEGATION_PREFIX.length)
    : filter.operator

  if (operator === "isNull") {
    return negated
      ? baseQuery.not(column, "is", null)
      : baseQuery.is(column, null)
  }

  if (operator === "in") {
    const values = Array.isArray(filter.value)
      ? filter.value.map(toFilterValue)
      : filter.value
    return negated
      ? baseQuery.notIn(column, values)
      : baseQuery.in(column, values)
  }

  if (!COMPARISON_OPERATORS.has(operator)) {
    console.warn(`buildQuery: unsupported operator: ${filter.operator}`)
    return baseQuery
  }

  const value = toFilterValue(filter.value)
  return negated
    ? baseQuery.not(column, operator, value)
    : applyComparison(baseQuery, column, operator, value)
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
      // The single argument is the already-parsed inner condition. Wrapping it
      // is what keeps `not(gt(id, 5))` from sharing a cache entry with
      // `gt(id, 5)`.
      not: (inner) => (inner === null ? null : `not(${inner})`),
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
  // console.log(tableName, parsed);
  // console.log(tableName, cursorFilters);

  let baseQuery = supabase.from(tableName).select("*")

  if (parsed.limit) {
    baseQuery = baseQuery.limit(parsed.limit)
  }

  if (offset) {
    baseQuery = baseQuery.range(offset, offset + 5)
  }
  if (parsed.sorts) {
    parsed.sorts.forEach((sort) => {
      baseQuery = baseQuery.order(sort.field.join("."), {
        ascending: sort.direction === "asc",
      })
    })
  }

  if (parsed.filters) {
    for (const filter of [...parsed.filters, ...cursorFilters]) {
      baseQuery = buildQuery(baseQuery, filter)
    }
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
