import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type DeleteMutationFnParams,
  type InsertMutationFnParams,
  type LoadSubsetOptions,
  type UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"
import {
  cursorCurrentToSearch,
  cursorWhereFromToSearch,
  keyColumnsToSearch,
  loadSubsetOptionsToSearch,
  subsetParamsToSearch,
} from "./postgrest-filters"
import { postgrestRequest } from "./postgrest-request"
import { isSynced } from "./realtime"

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
): Array<string> => {
  // The key shares the request URL's where/order/limit encoding
  // (`subsetParamsToSearch`) so the two cannot drift; the constant `select` is
  // excluded because it never distinguishes one subset from another.
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

type PageOptions = {
  /** The caller's row limit; `undefined` means "the full matching set". */
  limit?: number
  /** The starting offset (always 0 for cursor reads). */
  offset: number
  signal?: AbortSignal
}

/**
 * Read a full matching set (or the caller's `limit` rows) with offset paging,
 * looping past PostgREST's `db-max-rows` cap instead of silently truncating at
 * it. The first request asks for `count=exact` so the loop knows the total up
 * front and stops without a trailing empty probe; each later page advances the
 * offset by the rows actually received (self-correcting under concurrent
 * writes) and is capped by the observed page size and the rows still owed.
 */
async function fetchAllPages(
  supabase: SupabaseClient,
  tableName: string,
  baseSearch: URLSearchParams,
  { limit, offset: startOffset, signal }: PageOptions
): Promise<any[]> {
  // A zero limit is an empty window: return it without touching the network.
  if (limit === 0) {
    return []
  }

  // The base search already carries the caller's limit/offset (from the search
  // builders), so the first request is sent verbatim — its URL stays identical
  // to the single-request behaviour, and the query key that mirrors it.
  const first = await postgrestRequest(supabase, tableName, {
    method: "GET",
    search: baseSearch,
    signal,
    count: "exact",
  })
  const rows: any[] = first.data ? [...first.data] : []

  // The rows the first page returned size the server's cap; a later page that
  // comes back shorter than this means the server has no more rows.
  const pageSize = rows.length
  // `Content-Range` reports the whole matching set, so the rows reachable from
  // the starting offset are what remains past it. When the count header is
  // missing we fall back to paging until a short page appears.
  const total = first.count ?? Number.POSITIVE_INFINITY
  const remaining = Math.max(0, total - startOffset)
  const target = limit === undefined ? remaining : Math.min(limit, remaining)

  let lastPageSize = pageSize
  while (lastPageSize === pageSize && pageSize > 0 && rows.length < target) {
    const pageSearch = new URLSearchParams(baseSearch)
    pageSearch.set("offset", `${startOffset + rows.length}`)
    pageSearch.set("limit", `${Math.min(pageSize, target - rows.length)}`)
    const page = await postgrestRequest(supabase, tableName, {
      method: "GET",
      search: pageSearch,
      signal,
    })
    const pageRows: any[] = page.data ?? []
    rows.push(...pageRows)
    lastPageSize = pageRows.length
  }

  return rows
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
  const options = ctx.meta?.loadSubsetOptions ?? {}
  const search = loadSubsetOptionsToSearch(options)
  // Cursor reads pin their own window start, so they never carry an offset (see
  // loadSubsetOptionsToSearch); only a cursor-less read advances from `offset`.
  const startOffset = options.offset && !options.cursor ? options.offset : 0

  // A keyset request whose boundary column has ties (e.g. `orderBy(created_at)`
  // with repeated values) needs a second, unlimited request for the rows equal
  // to the boundary; the limited `whereFrom` page alone would skip them.
  //
  // Do not drop this on the grounds that core's ordered-source loader also
  // probes the boundary (`requestSnapshot({ where: eq(col, boundary) })`) and
  // usually pre-loads the same tie class: that probe is a window-path
  // optimization the adapter cannot assume ran. It is skipped when the boundary
  // value is unchanged, falls back to a full-source load for non-keyset orders,
  // and never runs for `loadSubset({ cursor })` calls made outside that path.
  // Honouring `whereCurrent` here is what makes the cursor correct on its own.
  const tiesSearch = cursorCurrentToSearch(options)
  if (!tiesSearch) {
    return await fetchAllPages(supabase, tableName, search, {
      limit: options.limit,
      offset: startOffset,
      signal: ctx.signal,
    })
  }

  const [ties, rows] = await Promise.all([
    // The tie read is deliberately unbounded by the caller's limit — every row
    // tied at the boundary must come back — but it is still paged so a tie class
    // larger than the cap is not truncated.
    fetchAllPages(supabase, tableName, tiesSearch, {
      offset: 0,
      signal: ctx.signal,
    }),
    fetchAllPages(supabase, tableName, search, {
      limit: options.limit,
      offset: startOffset,
      signal: ctx.signal,
    }),
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
