import {
  extractSimpleComparisons,
  type LoadSubsetOptions,
  type SimpleComparison,
} from "@tanstack/db"
import { type PostgrestParam, paramsToSearch, quoteValue } from "./common"

type WhereExpression = LoadSubsetOptions["where"]
type ColumnParam = Extract<PostgrestParam, { kind: "column" }>

/** Maps TanStack DB operators to Realtime postgres_changes operators. */
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
const NOT_PREFIX = "not_"

/**
 * Whether a value is a scalar Realtime can filter on. Anything else (null,
 * undefined, objects, non-finite numbers) makes the whole subscription fall
 * back to a catch-all rather than being coerced to a mismatching string.
 */
const isRealtimeScalar = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value)
  return (
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Date
  )
}

/**
 * Render a scalar for Realtime's PostgREST-style filter grammar, or null when
 * the value is not Realtime-serializable. Realtime shares PostgREST's
 * list/group quoting, so {@link quoteValue} quotes commas, parentheses, quotes,
 * backslashes, and surrounding whitespace to keep them from splitting a
 * condition.
 */
const serializeRealtimeValue = (value: unknown): string | null =>
  isRealtimeScalar(value) ? quoteValue(value) : null

const serializeRealtimeInValues = (value: unknown): string | null => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_IN_VALUES
  ) {
    return null
  }

  const serialized: string[] = []
  for (const entry of value) {
    const rendered = serializeRealtimeValue(entry)
    if (rendered === null) return null
    serialized.push(rendered)
  }
  return `(${serialized.join(",")})`
}

/** Convert one flattened TanStack comparison to a Realtime URL parameter. */
const comparisonToRealtimeParam = (
  comparison: SimpleComparison
): ColumnParam | null => {
  const operator = REALTIME_OPERATORS[comparison.operator]
  if (!operator) return null

  // Realtime can only evaluate one top-level table column per condition.
  const column =
    comparison.field?.length === 1 ? comparison.field[0] : undefined
  if (typeof column !== "string" || column.length === 0) return null

  const baseOperator = comparison.operator.startsWith(NOT_PREFIX)
    ? comparison.operator.slice(NOT_PREFIX.length)
    : comparison.operator

  if (baseOperator === "isNull") {
    return { kind: "column", column, operator, value: "null" }
  }

  if (baseOperator === "in") {
    const value = serializeRealtimeInValues(comparison.value)
    return value === null ? null : { kind: "column", column, operator, value }
  }

  const value = serializeRealtimeValue(comparison.value)
  return value === null ? null : { kind: "column", column, operator, value }
}

const paramToCondition = (param: ColumnParam): string =>
  `${param.column}=${param.operator}.${param.value}`

const compareKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/**
 * Build one set of URL parameters per active query for use in Realtime
 * subscriptions. Each non-empty params object represents comma-ANDed
 * `column=operator.value` conditions; an empty object represents a catch-all
 * subscription.
 */
export function realtimeFiltersToSearch(
  whereExpressions: WhereExpression[]
): URLSearchParams[] {
  const filters = new Map<string, URLSearchParams>()

  for (const where of whereExpressions) {
    let comparisons: SimpleComparison[]
    try {
      comparisons = extractSimpleComparisons(where)
    } catch {
      return [new URLSearchParams()]
    }

    if (comparisons.length === 0) return [new URLSearchParams()]

    const conditions = new Map<string, ColumnParam>()
    for (const comparison of comparisons) {
      const param = comparisonToRealtimeParam(comparison)
      if (param === null) return [new URLSearchParams()]
      conditions.set(paramToCondition(param), param)
    }

    const params = paramsToSearch(
      Array.from(conditions.entries())
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([, param]) => param)
    )
    const key = Array.from(params)
      .map(([column, value]) => `${column}=${value}`)
      .join(",")
    filters.set(key, params)
  }

  return filters.size > 0
    ? Array.from(filters.entries())
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([, params]) => params)
    : [new URLSearchParams()]
}
