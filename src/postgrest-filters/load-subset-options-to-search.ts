import {
  extractSimpleComparisons,
  type LoadSubsetOptions,
  type SimpleComparison,
} from "@tanstack/db"
import type { PostgrestParam } from "./common"
import { appendOffset, paramsToSearch, quoteValue } from "./common"
import { subsetParamsToSearch } from "./subset-params-to-search"

// Cursor operators arrive pre-flattened as `SimpleComparison`. Scalar values
// are emitted raw (top-level params must not be quoted); only IN members quote.
const CURSOR_SCALAR_OPERATORS: Record<string, string> = {
  eq: "eq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  not_eq: "not.eq",
}

/** Convert pre-flattened cursor comparisons to PostgREST params. */
function cursorToPostgrestParams(
  filters: SimpleComparison[]
): PostgrestParam[] {
  return filters.flatMap((filter): PostgrestParam[] => {
    const column = filter.field.join(".")
    if (filter.operator === "in") {
      const values = Array.isArray(filter.value) ? filter.value : []
      return [
        {
          kind: "column",
          column,
          operator: "in",
          value: `(${values.map(quoteValue).join(",")})`,
        },
      ]
    }
    if (filter.operator === "isNull") {
      return [{ kind: "column", column, operator: "is", value: "null" }]
    }
    const operator = CURSOR_SCALAR_OPERATORS[filter.operator]
    if (!operator) {
      console.warn(
        `cursorToPostgrestParams: unsupported operator: ${filter.operator}`
      )
      return []
    }
    return [{ kind: "column", column, operator, value: `${filter.value}` }]
  })
}

/** Render the cursor's `whereFrom` (keyset "rows after boundary") filters. */
export function cursorWhereFromToSearch(
  cursor: LoadSubsetOptions["cursor"]
): URLSearchParams {
  const filters = cursor ? [...extractSimpleComparisons(cursor.whereFrom)] : []
  return paramsToSearch(cursorToPostgrestParams(filters))
}

/**
 * Build the full read query string for a TanStack DB subset load: the shared
 * subset params ({@link subsetParamsToSearch}) plus `select=*` and the cursor's
 * keyset (`whereFrom`) filters, or `offset` for cursor-less requests.
 */
export function loadSubsetOptionsToSearch(
  options: LoadSubsetOptions
): URLSearchParams {
  const search = new URLSearchParams()
  search.set("select", "*")
  for (const [key, value] of subsetParamsToSearch(options)) {
    search.append(key, value)
  }

  for (const [key, value] of cursorWhereFromToSearch(options.cursor)) {
    search.append(key, value)
  }

  // Cursor and offset are mutually exclusive: core may send both, but the
  // cursor already pins the window start, so an offset on top of it re-skips
  // rows the cursor has already moved past. Honour offset only without a cursor.
  if (options.offset && !options.cursor) {
    appendOffset(search, options.offset)
  }
  return search
}

/**
 * Build the read query string for the boundary-tie request that accompanies a
 * cursor load: the same `where`/`order` as the main request plus the cursor's
 * `whereCurrent` (rows equal to the boundary value), and deliberately **no
 * limit** — every tied row must come back or a row sharing the boundary value
 * with `orderBy` would be skipped. Returns `null` when there is no cursor or no
 * tie predicate, so the caller can fall back to the single main request.
 */
export function cursorCurrentToSearch(
  options: LoadSubsetOptions
): URLSearchParams | null {
  if (!options.cursor) return null
  const currentFilters = [
    ...extractSimpleComparisons(options.cursor.whereCurrent),
  ]
  if (currentFilters.length === 0) return null

  const search = new URLSearchParams()
  search.set("select", "*")
  // where + order only — no limit, no offset, no `whereFrom`.
  for (const [key, value] of subsetParamsToSearch({
    where: options.where,
    orderBy: options.orderBy,
  })) {
    search.append(key, value)
  }
  for (const [key, value] of paramsToSearch(
    cursorToPostgrestParams(currentFilters)
  )) {
    search.append(key, value)
  }
  return search
}
