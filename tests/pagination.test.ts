import { createClient } from "@supabase/supabase-js"
import {
  createCollection,
  createLiveQueryCollection,
  createLiveQueryWindowController,
} from "@tanstack/db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { z } from "zod"
import { supabaseCollectionOptions } from "../src/index"
import { getSearches, makePaginatingFetch } from "./pagination.utils"
import { SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

// A live infinite query (`useLiveInfiniteQuery`) is, without React, a
// `createLiveQueryWindowController` over an ordered+limited live query. Growing
// the window makes core hand the adapter keyset `LoadSubsetOptions.cursor`s,
// which is the path these tests exercise end to end against a mocked PostgREST.
//
// NOTE — two kinds of `<col>=eq.<boundary>` reads appear below:
//   1. Boundary probe: core's `OrderedSourceLoader.loadBoundary()` issues
//      `requestSnapshot({ where: eq(col, boundary) })` — where only, no order,
//      no limit — to settle the peek row that decides `hasNextPage`. The adapter
//      renders it `select=*&<col>=eq.<b>`.
//   2. `whereCurrent` tie read: the adapter's `supabaseQueryFn` emits it when
//      `LoadSubsetOptions.cursor` is set, paired with the `gt`/`lt` keyset read.
//      It is ordered and unlimited (`select=*&order=...&<col>=eq.<b>`) so every
//      row tied at the boundary loads even when the tie class exceeds the page.
// In the window path these overlap: the boundary probe already pulls the full
// tie class before the `whereCurrent` read runs, so the tie class is fetched
// twice. The adapter must still emit `whereCurrent` — it honors the cursor
// contract and cannot assume the boundary probe ran (`loadBoundary` skips when
// the boundary value is unchanged, falls back to a full-source load for
// non-keyset orders, and never runs for `loadSubset({ cursor })` calls outside
// the window path). Collapsing the duplication is core's call, not the adapter's.

const itemsSchema = z.object({ id: z.number(), rank: z.number() })

// rank has a tie class (20) spanning ids 2–4 that straddles the first page.
const FIXTURE = [
  { id: 1, rank: 10 },
  { id: 2, rank: 20 },
  { id: 3, rank: 20 },
  { id: 4, rank: 20 },
  { id: 5, rank: 30 },
  { id: 6, rank: 40 },
]

/** A Supabase-backed source collection over the paginating mock. */
function makeCollection(mockFetch: ReturnType<typeof makePaginatingFetch>) {
  return createCollection(
    supabaseCollectionOptions({
      tableName: "items",
      keys: ["id"],
      schema: itemsSchema,
      supabase: createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { fetch: mockFetch },
      }),
    })
  )
}

/** Wrap a live query in a window controller with an active subscriber. */
function windowController(
  live: ReturnType<typeof createLiveQueryCollection>,
  cleanups: Array<() => void>,
  pageSize: number
) {
  const controller = createLiveQueryWindowController(live, { pageSize })
  // A subscriber activates the window lease so pages actually load.
  const unsub = controller.subscribe(() => {})
  cleanups.push(() => {
    unsub()
    controller.dispose()
    live.cleanup()
  })
  return controller
}

const ids = (snapshot: { data: ReadonlyArray<unknown> }) =>
  snapshot.data.map((row) => (row as { id: number }).id)

describe("live infinite query (windowed) pagination", () => {
  let collection: ReturnType<typeof makeCollection>
  let mockFetch: ReturnType<typeof makePaginatingFetch>
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    mockFetch = makePaginatingFetch(FIXTURE)
    collection = makeCollection(mockFetch)
    cleanups.push(() => {
      collection.cleanup()
    })
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup()
    }
  })

  test("fetches a single page without a keyset cursor", async () => {
    const live = createLiveQueryCollection((q) =>
      q
        .from({ item: collection })
        .orderBy(({ item }) => item.id)
        .limit(2)
    )
    const controller = windowController(live, cleanups, 2)

    await controller.preload()
    const snapshot = controller.getSnapshot()
    // One committed page of `pageSize`, with more rows available.
    expect(snapshot.pages.map((page) => page.map((row) => row.id))).toEqual([
      [1, 2],
    ])
    expect(ids(snapshot)).toEqual([1, 2])
    expect(snapshot.hasNextPage).toBe(true)

    // The first page is a plain ordered window (one peek row past the page)
    // plus core's boundary probe — no keyset cursor (`gt`) and no offset yet.
    // An unlimited read sends no limit at all — the server's row cap sizes it —
    // and carries the key columns as order tie-breakers.
    expect(getSearches(mockFetch)).toEqual([
      "select=*&order=id.asc&limit=3", // window + 1 peek row
      "select=*&id=eq.3&order=id.asc", // boundary probe (loadBoundary) settles the peek
    ])
  })

  test("grows the window with a keyset cursor and never an offset", async () => {
    const live = createLiveQueryCollection((q) =>
      q
        .from({ item: collection })
        .orderBy(({ item }) => item.id)
        .limit(2)
    )
    const controller = windowController(live, cleanups, 2)

    await controller.preload()
    expect(ids(controller.getSnapshot())).toEqual([1, 2])

    await controller.fetchNextPage()
    // Page 1 rows are preserved and the result is a contiguous ordered prefix.
    expect(ids(controller.getSnapshot())).toEqual([1, 2, 3, 4])

    // The exact PostgREST reads the flow emits. The next page is a keyset
    // request from the boundary (id 3): ordered, limited, and — crucially —
    // with no offset re-skipping rows. No request carries an offset.
    expect(getSearches(mockFetch)).toEqual([
      "select=*&order=id.asc&limit=3", // page 1: window + 1 peek row
      "select=*&id=eq.3&order=id.asc", // boundary probe (loadBoundary) settles the peek
      "select=*&id=eq.3&order=id.asc", // page 2: whereCurrent tie read (unlimited, not capped by the window limit)
      "select=*&id=gt.3&order=id.asc&limit=2", // page 2: whereFrom keyset read
      "select=*&id=eq.5&order=id.asc", // boundary probe for the next peek
    ])
  })

  test("fetches the full boundary tie class so no tied row is skipped", async () => {
    const live = createLiveQueryCollection((q) =>
      q
        .from({ item: collection })
        .orderBy(({ item }) => item.rank)
        .limit(2)
    )
    const controller = windowController(live, cleanups, 2)

    await controller.preload()
    expect(ids(controller.getSnapshot())).toEqual([1, 2])

    await controller.fetchNextPage()
    const result = ids(controller.getSnapshot())
    // The whole rank-20 tie class (ids 2–4) is loaded even though id 4 sits
    // beyond page 1's peek, so the window stays a contiguous ordered prefix
    // with no gaps and no duplicates.
    expect(result).toContain(4)
    expect(result).toEqual([1, 2, 3, 4])
    expect(new Set(result).size).toBe(result.length)

    // Same boundary values (rank 20) exercise `whereCurrent`. This test locks
    // the shape the adapter must emit: the tie read (3rd) keeps the order,
    // filters to the boundary with `eq`, and sends no limit rather than being
    // capped by the window limit; the keyset read (4th) advances strictly past
    // the boundary with `gt`; neither carries an offset. The key column `id`
    // is appended to every order as a tie-breaker so pages are deterministic.
    // (Here id 4 is in fact already loaded by the boundary probe — 2nd read,
    // `rank=eq.20`, no order — which makes the `whereCurrent` read redundant in
    // the window path; see the module note. The adapter emits it regardless
    // because it honors the cursor contract.)
    expect(getSearches(mockFetch)).toEqual([
      "select=*&order=rank.asc,id.asc&limit=3", // page 1: window + 1 peek row
      "select=*&rank=eq.20&order=id.asc", // boundary probe (loadBoundary): full tie class
      "select=*&rank=eq.20&order=rank.asc,id.asc", // page 2: whereCurrent tie read
      "select=*&rank=gt.20&order=rank.asc,id.asc&limit=1", // page 2: whereFrom keyset read
      "select=*&rank=eq.30&order=id.asc", // boundary probe for the next peek
    ])
  })
})
