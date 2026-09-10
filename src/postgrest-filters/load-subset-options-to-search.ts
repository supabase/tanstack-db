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

/**
 * Build the full read query string for a TanStack DB subset load: the shared
 * subset params ({@link subsetParamsToSearch}) plus `select=*`, cursor filters,
 * and offset.
 */
export function loadSubsetOptionsToSearch(
  options: LoadSubsetOptions
): URLSearchParams {
  const search = new URLSearchParams()
  search.set("select", "*")
  for (const [key, value] of subsetParamsToSearch(options)) {
    search.append(key, value)
  }

  const cursorFilters = options.cursor
    ? [...extractSimpleComparisons(options.cursor.whereFrom)]
    : []
  for (const [key, value] of paramsToSearch(
    cursorToPostgrestParams(cursorFilters)
  )) {
    search.append(key, value)
  }

  if (options.offset) {
    appendOffset(search, options.offset)
  }
  return search
}
