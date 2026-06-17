import type {
  RealtimePostgresChangesFilter,
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from "@supabase/supabase-js"
import {
  type Collection,
  extractSimpleComparisons,
  type LoadSubsetOptions,
  type SimpleComparison,
} from "@tanstack/db"

type WhereExpression = LoadSubsetOptions["where"]

/**
 * Maps TanStack DB comparison operators to the operators supported by Supabase
 * Realtime postgres_changes filters. Realtime only supports a single filter on
 * a single column per subscription, using one of these operators.
 * @see https://supabase.com/docs/guides/realtime/postgres-changes#available-filters
 */
const REALTIME_OPERATORS: Record<string, string> = {
  eq: "eq",
  not_eq: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  in: "in",
}

/**
 * Converts a single TanStack DB comparison into a Supabase Realtime filter
 * string (`column=operator.value`). Returns `null` when the comparison cannot
 * be expressed as a Realtime filter (unsupported operator or missing column).
 */
const toRealtimeFilter = (comparison: SimpleComparison): string | null => {
  const operator = REALTIME_OPERATORS[comparison.operator]
  if (!operator) {
    return null
  }

  const column = comparison.field?.join(".")
  if (!column) {
    return null
  }

  if (operator === "in") {
    const values = Array.isArray(comparison.value)
      ? comparison.value
      : [comparison.value]
    return `${column}=in.(${values.join(",")})`
  }

  return `${column}=${operator}.${comparison.value}`
}

/**
 * Builds the set of Realtime filter strings for a table from the WHERE
 * expressions of its active queries.
 *
 * Realtime only supports a single comparison per subscription, so a query is
 * only translated into a filter when its WHERE clause is exactly one supported
 * comparison. Any query that cannot be represented (no filter, multiple
 * conditions, or an unsupported operator) forces a catch-all subscription,
 * represented by a `null` entry, that receives every change for the table.
 */
export const buildRealtimeFilters = (
  whereExpressions: Array<WhereExpression>
): Array<string | null> => {
  const filters = new Set<string>()

  for (const where of whereExpressions) {
    let comparisons: Array<SimpleComparison>
    try {
      comparisons = extractSimpleComparisons(where)
    } catch {
      // extractSimpleComparisons throws on expressions it can't represent as
      // simple comparisons (e.g. or(), like). Fall back to receiving every
      // change for the table.
      return [null]
    }

    if (comparisons.length !== 1) {
      // No filter or a composite filter cannot be expressed in Realtime, so we
      // must receive every change for the table.
      return [null]
    }

    const filter = toRealtimeFilter(comparisons[0])
    if (filter === null) {
      return [null]
    }
    filters.add(filter)
  }

  return filters.size > 0 ? Array.from(filters) : [null]
}

/**
 * Subscribes to Supabase Realtime changes for a table and writes inserts,
 * updates, and deletes into the collection. One listener is registered per
 * provided filter so the union of the active queries' filters is covered.
 */
export const attachSupabaseListeners = <
  T extends Record<string, any>,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  tableName: string,
  collection: Collection<T, TKey>,
  filters: Array<string | null> = [null]
): ReturnType<SupabaseClient["channel"]> | null => {
  if (!supabase.channel) {
    return null
  }

  const channel = supabase.channel(tableName)

  const handlePayload = (payload: RealtimePostgresChangesPayload<T>) => {
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

  for (const filter of filters) {
    const changesFilter: RealtimePostgresChangesFilter<"*"> = {
      event: "*",
      schema: "public",
      table: tableName,
    }
    if (filter) {
      changesFilter.filter = filter
    }
    channel.on<T>("postgres_changes", changesFilter, handlePayload)
  }

  channel.subscribe()

  return channel
}
