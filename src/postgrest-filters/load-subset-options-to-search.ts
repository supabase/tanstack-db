import type { LoadSubsetOptions } from "@tanstack/db"
import {
  appendOrder,
  paramsToSearch,
  type Sort,
  toPostgrestParams,
} from "./common"
import { orderByToSorts } from "./subset-params-to-search"

/**
 * Render the cursor's `whereFrom` (keyset "rows after boundary") filters.
 *
 * Uses the adapter's own {@link toPostgrestParams} renderer so it handles the
 * composite cursors core emits for multi-column `orderBy`
 * (`or(gt(c1,v1), and(eq(c1,v1), gt(c2,v2)))`) and serialises Date boundaries
 * as ISO 8601 — both of which the pre-flattening `extractSimpleComparisons`
 * path could not. `strict` surfaces any un-pushable cursor rather than silently
 * dropping a predicate and widening the window.
 */
export function cursorWhereFromToSearch(
  cursor: LoadSubsetOptions["cursor"]
): URLSearchParams {
  if (!cursor) return new URLSearchParams()
  return paramsToSearch(toPostgrestParams(cursor.whereFrom, { strict: true }))
}

/**
 * The sort applied to every page of a subset read: the requested order
 * followed by any key columns it does not already sort on. Offset pagination
 * needs a total order even when the caller omits a sort or sorts by a
 * non-unique column. Explicit key sort directions are kept.
 */
export function subsetSorts(
  options: LoadSubsetOptions,
  keys: readonly string[] = []
): Sort[] {
  const sorts = orderByToSorts(options.orderBy)
  for (const key of keys) {
    if (!sorts.some((sort) => sort.column === key)) {
      sorts.push({ column: key, ascending: true })
    }
  }
  return sorts
}

/** `select=*` plus the subset's where filters — the start of every read. */
function baseReadSearch(options: LoadSubsetOptions): URLSearchParams {
  const search = new URLSearchParams()
  search.set("select", "*")
  for (const [key, value] of paramsToSearch(
    toPostgrestParams(options.where, { mergeIn: true })
  )) {
    search.append(key, value)
  }
  return search
}

/**
 * Build the query string shared by every page of a subset read: `select=*`,
 * the where filters, the cursor's keyset (`whereFrom`) filters, and the
 * paginated order ({@link subsetSorts}). `limit` and `offset` are deliberately
 * left out — the pagination loop sets them per page, and honours `offset` only
 * without a cursor, since the cursor already pins the window start.
 */
export function loadSubsetOptionsToSearch(
  options: LoadSubsetOptions,
  keys: readonly string[] = []
): URLSearchParams {
  const search = baseReadSearch(options)
  for (const [key, value] of cursorWhereFromToSearch(options.cursor)) {
    search.append(key, value)
  }
  appendOrder(search, subsetSorts(options, keys))
  return search
}

/**
 * Build the read query string for the boundary-tie request that accompanies a
 * cursor load: the same `where`/`order` as the main request plus the cursor's
 * `whereCurrent` (rows equal to the boundary value), and deliberately **no
 * caller limit** — every tied row must come back or a row sharing the boundary
 * value with `orderBy` would be skipped. The pagination loop still pages it.
 * Returns `null` when there is no cursor or no tie predicate, so the caller can
 * fall back to the single main request.
 */
export function cursorCurrentToSearch(
  options: LoadSubsetOptions,
  keys: readonly string[] = []
): URLSearchParams | null {
  if (!options.cursor) return null
  const currentParams = toPostgrestParams(options.cursor.whereCurrent, {
    strict: true,
  })
  if (currentParams.length === 0) return null

  const search = baseReadSearch(options)
  for (const [key, value] of paramsToSearch(currentParams)) {
    search.append(key, value)
  }
  appendOrder(search, subsetSorts(options, keys))
  return search
}
