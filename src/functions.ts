import type { SupabaseClient } from "@supabase/supabase-js"
import type {
  DeleteMutationFnParams,
  InsertMutationFnParams,
  LoadSubsetOptions,
  UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"
import {
  cursorCurrentToSearch,
  cursorWhereFromToSearch,
  keyColumnsToSearch,
  loadSubsetOptionsToSearch,
  subsetParamsToSearch,
} from "./postgrest-filters"
import { appendLimit, appendOffset } from "./postgrest-filters/common"
import { postgrestRequest } from "./postgrest-request"
import { isSynced } from "./realtime"

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
): Array<string> => {
  // The key shares the request URL's where/order/limit encoding
  // (`subsetParamsToSearch`) so the two cannot drift; the constant `select` and
  // the key-column tie-breakers are excluded because they never distinguish one
  // subset from another.
  //
  // Pagination params (cursor/offset) ARE included: query-db-collection keys row
  // ownership by this key, so distinct windows of the same subset (same
  // where/order/limit, different cursor/offset) must not collide — otherwise a
  // later page's result would take over the earlier page's rows and delete them.
  // The key still starts with `[tableName]` so `syncTableSubscription` keeps
  // matching every window of the table by prefix.
  const search = subsetParamsToSearch(ctx)
  if (ctx.cursor) {
    try {
      for (const [k, v] of cursorWhereFromToSearch(ctx.cursor)) {
        search.append(k, v)
      }
    } catch {
      // The queryKey function must never throw — query-db-collection calls it
      // synchronously to key row ownership. If the cursor cannot be rendered
      // (an un-pushable predicate), fall back to a deterministic discriminator
      // so distinct windows still get distinct keys and cannot take over and
      // delete each other's rows.
      search.append("cursor", JSON.stringify(ctx.cursor.whereFrom))
    }
  }
  if (ctx.offset && !ctx.cursor) {
    search.append("offset", `${ctx.offset}`)
  }
  const key = search.toString()
  return key ? [tableName, key] : [tableName]
}

type Row = Record<string, unknown>

interface PageLoopOptions {
  /** Total rows wanted; undefined loads every matching row. */
  limit?: number
  /** Rows to skip before the first page. */
  offset?: number
}

/**
 * Fetch every row `search` matches (or the first `limit` of them).
 *
 * No page-size limit is sent. Each request lets the server return as many rows
 * as its own max-rows setting allows, then the `Content-Range` count PostgREST
 * reports (via `Prefer: count=exact`) tells us whether more rows remain. If so,
 * the offset advances by the number of rows actually received and the next
 * request continues from there — rinse and repeat until the offset reaches the
 * total. When the caller sets its own `limit`, that limit is forwarded and the
 * loop also stops once enough rows are collected.
 *
 * Fallbacks when no count header comes back: with a caller `limit`, an
 * under-full page is treated as the last one; without a caller `limit`, the
 * server is assumed to have returned every matching row in this single page,
 * since blindly advancing the offset with no total to check against risks
 * looping forever.
 *
 * Known limitation: a row deleted by another client between two page requests
 * shifts the remaining rows one offset back, so the first row of the next page
 * is missed until the query refetches. Keyset addressing would avoid this.
 */
const fetchPages = async (
  supabase: SupabaseClient,
  tableName: string,
  search: URLSearchParams,
  { limit, offset = 0 }: PageLoopOptions,
  signal: AbortSignal
): Promise<Row[]> => {
  const rows: Row[] = []
  let pageOffset = offset

  while (limit === undefined || rows.length < limit) {
    signal.throwIfAborted()

    const pageSearch = new URLSearchParams(search)
    // Only the caller's own limit is ever sent; the loop never adds one of its
    // own, so each page is capped solely by the server's max-rows setting.
    const requested = limit === undefined ? undefined : limit - rows.length
    if (requested !== undefined) {
      appendLimit(pageSearch, requested)
    }
    if (pageOffset) {
      appendOffset(pageSearch, pageOffset)
    }

    const { data, count } = await postgrestRequest(supabase, tableName, {
      method: "GET",
      search: pageSearch,
      count: "exact",
      signal,
    })
    const page: Row[] = data ?? []
    for (const row of page) {
      rows.push(row)
    }
    if (page.length === 0) {
      break
    }

    // The count covers every matching row, including the ones skipped by the
    // offset. Advance by what was received, not what was requested, so a
    // server cap below the caller's limit does not leave a gap.
    pageOffset += page.length
    let complete: boolean
    if (count !== null) {
      complete = pageOffset >= count
    } else if (requested !== undefined) {
      complete = page.length < requested
    } else {
      complete = true
    }
    if (complete) {
      break
    }
  }

  return rows
}

/**
 * Load a TanStack DB subset: the main read (where + cursor `whereFrom` + order,
 * paged by {@link fetchPages}) and, for cursor loads with a tie predicate, the
 * boundary-tie read alongside it.
 */
export const supabaseQueryFn = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  ctx: {
    client: QueryClient
    queryKey: readonly unknown[]
    signal: AbortSignal
    meta: QueryMeta | undefined
    pageParam?: unknown
    direction?: unknown
  }
): Promise<any[]> => {
  const options: LoadSubsetOptions = ctx.meta?.loadSubsetOptions ?? {}
  const search = loadSubsetOptionsToSearch(options, keys)
  // Cursor and offset are mutually exclusive: core may send both, but the
  // cursor already pins the window start, so an offset on top of it re-skips
  // rows the cursor has already moved past. Honour offset only without a cursor.
  const offset = options.cursor ? 0 : options.offset

  // A keyset request whose boundary column has ties (e.g. `orderBy(created_at)`
  // with repeated values) needs a second request, unbounded by the caller's
  // limit, for the rows equal to the boundary; the limited `whereFrom` page
  // alone would skip them.
  //
  // Do not drop this on the grounds that core's ordered-source loader also
  // probes the boundary (`requestSnapshot({ where: eq(col, boundary) })`) and
  // usually pre-loads the same tie class: that probe is a window-path
  // optimization the adapter cannot assume ran. It is skipped when the boundary
  // value is unchanged, falls back to a full-source load for non-keyset orders,
  // and never runs for `loadSubset({ cursor })` calls made outside that path.
  // Honouring `whereCurrent` here is what makes the cursor correct on its own.
  const tiesSearch = cursorCurrentToSearch(options, keys)
  const [ties, rows] = await Promise.all([
    tiesSearch
      ? fetchPages(supabase, tableName, tiesSearch, {}, ctx.signal)
      : [],
    fetchPages(
      supabase,
      tableName,
      search,
      { limit: options.limit, offset },
      ctx.signal
    ),
  ])
  // `whereCurrent` (== boundary) and `whereFrom` (> / < boundary) are disjoint,
  // so concatenation never duplicates; the collection re-sorts locally.
  return [...ties, ...rows]
}

export const supabaseOnInsert = async (
  supabase: SupabaseClient,
  tableName: string,
  { transaction, collection }: InsertMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { data } = await postgrestRequest(supabase, tableName, {
        method: "POST",
        search: new URLSearchParams({ select: "*" }),
        body: { ...mutation.modified },
        returnRows: true,
        single: true,
      })

      mutation.modified = data
      // The data has been inserted and confirmed by the server, so we can write
      // it to the collection. Realtime may already have echoed the insert, in
      // which case this is an update of the synced row rather than an insert.
      collection.utils.writeUpsert(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnUpdate = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  { transaction, collection }: UpdateMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { original, changes } = mutation
      const search = keyColumnsToSearch(keys, original)
      search.set("select", "*")
      const { data } = await postgrestRequest(supabase, tableName, {
        method: "PATCH",
        search,
        body: { ...original, ...changes },
        returnRows: true,
        single: true,
      })

      mutation.modified = data
      collection.utils.writeUpdate(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnDelete = async (
  supabase: SupabaseClient,
  tableName: string,
  keys: string[],
  { transaction, collection }: DeleteMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      await postgrestRequest(supabase, tableName, {
        method: "DELETE",
        search: keyColumnsToSearch(keys, mutation.original),
      })

      // The data has been deleted and confirmed by the server, so we can write
      // it to the collection — unless Realtime already echoed the delete, in
      // which case the synced row is gone and writing again would throw.
      const key = collection.getKeyFromItem(mutation.original)
      if (isSynced(collection, key)) {
        collection.utils.writeDelete(key)
      }
    })
  )

  return { refetch: false }
}
