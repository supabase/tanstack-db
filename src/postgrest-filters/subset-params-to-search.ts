import { type LoadSubsetOptions, parseOrderByExpression } from "@tanstack/db"
import {
  appendLimit,
  appendOrder,
  paramsToSearch,
  toPostgrestParams,
} from "./common"

/**
 * Encode the params that identify a cached subset — where filters, order, and
 * limit. Deliberately excludes `select`, `cursor`, and `offset`: those are the
 * per-page request details, not part of what distinguishes one subset from
 * another. This is the shared core of the request URL and the query key, so the
 * two cannot drift.
 */
export function subsetParamsToSearch(
  options: LoadSubsetOptions
): URLSearchParams {
  const { where, orderBy, limit } = options
  const search = paramsToSearch(toPostgrestParams(where, { mergeIn: true }))
  appendOrder(
    search,
    parseOrderByExpression(orderBy).map((sort) => ({
      column: sort.field.join("."),
      ascending: sort.direction === "asc",
    }))
  )
  if (limit) {
    appendLimit(search, limit)
  }
  return search
}
