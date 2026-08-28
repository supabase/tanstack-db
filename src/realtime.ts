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

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE"

export type RealtimeSubscription = {
  channel: ReturnType<SupabaseClient["channel"]>
  /**
   * Resolves once the channel reached a terminal subscription state, or after
   * {@link SUBSCRIBE_TIMEOUT_MS} if the server never answers. Never rejects, so
   * callers can safely gate work on it without an unreachable Realtime server
   * blocking them forever.
   */
  subscribed: Promise<void>
}

/**
 * Maps TanStack DB comparison operators to the operators supported by Supabase
 * Realtime postgres_changes filters.
 * @see https://supabase.com/docs/guides/realtime/postgres-changes#available-filters
 */
const REALTIME_OPERATORS: Record<string, string> = {
  eq: "eq",
  not_eq: "neq",
  gt: "gt",
  not_gt: "not.gt",
  gte: "gte",
  not_gte: "not.gte",
  lt: "lt",
  not_lt: "not.lt",
  lte: "lte",
  not_lte: "not.lte",
  in: "in",
  not_in: "not.in",
  isNull: "is",
  not_isNull: "not.is",
}

/** Realtime rejects `in` filters with more than this many values. */
const MAX_IN_VALUES = 100

/** Never let a fetch wait longer than this for the channel to subscribe. */
const SUBSCRIBE_TIMEOUT_MS = 2000

/**
 * Characters that carry meaning in a filter string: `,` separates ANDed
 * conditions and the `in` list, `(`/`)` delimit that list, and `"`/`\` are the
 * quoting characters themselves.
 */
const RESERVED_CHARACTERS = /[,()"\\]/
const QUOTED_CHARACTERS = /["\\]/g

const NOT_PREFIX = "not_"

/**
 * Renders a value the way PostgREST expects it inside a filter string, quoting
 * strings that contain reserved characters. Returns `null` for values Realtime
 * cannot compare against, which forces the caller to fall back to an unfiltered
 * subscription rather than send a filter that means something else.
 */
const serializeValue = (value: unknown): string | null => {
  if (typeof value === "boolean") {
    return String(value)
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null
  }
  if (typeof value === "bigint") {
    return String(value)
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === "string") {
    if (value.length === 0 || RESERVED_CHARACTERS.test(value)) {
      return `"${value.replace(QUOTED_CHARACTERS, "\\$&")}"`
    }
    return value
  }
  return null
}

const serializeInValues = (value: unknown): string | null => {
  if (!Array.isArray(value)) {
    return null
  }
  // An empty list matches nothing and `in.()` is not valid filter syntax.
  if (value.length === 0 || value.length > MAX_IN_VALUES) {
    return null
  }

  const serialized: Array<string> = []
  for (const entry of value) {
    const rendered = serializeValue(entry)
    if (rendered === null) {
      return null
    }
    serialized.push(rendered)
  }
  return `(${serialized.join(",")})`
}

/**
 * Converts a single TanStack DB comparison into a Supabase Realtime filter
 * string (`column=operator.value`). Returns `null` when the comparison cannot
 * be expressed as a Realtime filter.
 */
const toRealtimeFilter = (comparison: SimpleComparison): string | null => {
  const operator = REALTIME_OPERATORS[comparison.operator]
  if (!operator) {
    return null
  }

  // Realtime evaluates filters against a single top-level column, so a nested
  // field path has no equivalent.
  const column =
    comparison.field?.length === 1 ? comparison.field[0] : undefined
  if (typeof column !== "string" || column.length === 0) {
    return null
  }

  const baseOperator = comparison.operator.startsWith(NOT_PREFIX)
    ? comparison.operator.slice(NOT_PREFIX.length)
    : comparison.operator

  if (baseOperator === "isNull") {
    return `${column}=${operator}.null`
  }

  if (baseOperator === "in") {
    const values = serializeInValues(comparison.value)
    return values === null ? null : `${column}=${operator}.${values}`
  }

  const value = serializeValue(comparison.value)
  return value === null ? null : `${column}=${operator}.${value}`
}

/**
 * Builds the set of Realtime filter strings for a table from the WHERE
 * expressions of its active queries.
 *
 * A query's conditions are ANDed into a single filter string using the
 * comma syntax Realtime supports. Any query that cannot be represented (no
 * WHERE clause, an unsupported operator, or a value that cannot be rendered
 * safely) forces a catch-all subscription, represented by a single `null`
 * entry, that receives every change for the table.
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

    if (comparisons.length === 0) {
      return [null]
    }

    const conditions: Array<string> = []
    for (const comparison of comparisons) {
      const condition = toRealtimeFilter(comparison)
      if (condition === null) {
        return [null]
      }
      conditions.push(condition)
    }
    // Sorted so that two queries expressing the same conditions in a different
    // order share one subscription.
    filters.add(conditions.sort().join(","))
  }

  return filters.size > 0 ? Array.from(filters).sort() : [null]
}

/**
 * Subscribes to Supabase Realtime changes for a table and writes inserts,
 * updates, and deletes into the collection.
 *
 * Filters are applied to INSERT and UPDATE listeners only: a filtered event is
 * Realtime telling us the row matches an active query, which is what makes it
 * belong in the collection — including a row that an UPDATE moved into that
 * query's window. Two extra unfiltered listeners cover what a filtered
 * subscription cannot see:
 *
 * - UPDATE, so a row already in the collection still receives its changes after
 *   it stops matching the filter instead of going stale.
 * - DELETE, because Realtime only delivers filtered delete events for tables
 *   with `replica identity full`, and delete payloads are just the key anyway.
 */
export const attachSupabaseListeners = <
  T extends Record<string, any>,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  topic: string,
  tableName: string,
  collection: Collection<T, TKey>,
  filters: Array<string | null> = [null]
): RealtimeSubscription | null => {
  if (!supabase.channel) {
    return null
  }

  const channel = supabase.channel(topic)

  const changesFilter = <TEvent extends ChangeEvent>(
    event: TEvent,
    filter: string | null
  ): RealtimePostgresChangesFilter<TEvent> => {
    const config: RealtimePostgresChangesFilter<TEvent> = {
      event,
      schema: "public",
      table: tableName,
    }
    if (filter) {
      config.filter = filter
    }
    return config
  }

  // The row matches an active query's filter, so it belongs in the collection
  // whether or not we have seen it before.
  const handleUpsert = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "INSERT" && payload.eventType !== "UPDATE") {
      return
    }
    const row = payload.new as T
    const id = collection.getKeyFromItem(row)
    if (collection.has(id)) {
      collection.utils.writeUpdate(row)
    } else {
      collection.utils.writeInsert(row)
    }
  }

  // Unfiltered updates arrive for every row in the table, so only rows the
  // collection already holds are written — otherwise it would mirror the whole
  // table locally.
  const handleKnownUpdate = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "UPDATE") {
      return
    }
    const row = payload.new as T
    const id = collection.getKeyFromItem(row)
    if (collection.has(id)) {
      collection.utils.writeUpdate(row)
    }
  }

  const handleDelete = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "DELETE") {
      return
    }
    const id = collection.getKeyFromItem(payload.old as T)
    if (collection.has(id)) {
      collection.utils.writeDelete(id)
    }
  }

  for (const filter of filters) {
    channel.on<T>("postgres_changes", changesFilter("INSERT", filter), (p) =>
      handleUpsert(p as RealtimePostgresChangesPayload<T>)
    )
    channel.on<T>("postgres_changes", changesFilter("UPDATE", filter), (p) =>
      handleUpsert(p as RealtimePostgresChangesPayload<T>)
    )
  }

  if (filters.some((filter) => filter !== null)) {
    channel.on<T>("postgres_changes", changesFilter("UPDATE", null), (p) =>
      handleKnownUpdate(p as RealtimePostgresChangesPayload<T>)
    )
  }

  channel.on<T>("postgres_changes", changesFilter("DELETE", null), (p) =>
    handleDelete(p as RealtimePostgresChangesPayload<T>)
  )

  const subscribed = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, SUBSCRIBE_TIMEOUT_MS)
    const settle = () => {
      clearTimeout(timeout)
      resolve()
    }
    try {
      channel.subscribe(settle)
    } catch {
      // subscribe() throws synchronously on an already-joined channel. Data
      // loading must not be held up by a channel that will never connect.
      settle()
    }
  })

  return { channel, subscribed }
}
