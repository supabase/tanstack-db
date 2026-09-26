import { createClient } from "@supabase/supabase-js"
import { IR, inArray, type LoadSubsetOptions } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { describe, expect, test, vi } from "vitest"
import { MAX_URL_LENGTH, supabaseQueryFn } from "../src/functions"
import { loadSubsetOptionsToSearch } from "../src/postgrest-filters"
import {
  getRawUrls,
  getSearches,
  makePaginatingFetch,
} from "./pagination.utils"
import { SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

// Same table shape `makePaginatingFetch` was built for: a bare numeric `id`.
const idRef = new IR.PropRef<number>(["id"])

// The base table URL `supabaseQueryFn` measures every subset's rendered URL
// against (see `measureSubset` in src/functions.ts) — computed once here so
// `idsExceedingLength` can size an id list against the same budget the
// production splitter uses.
const BASE_URL_LENGTH = createClient(SUPABASE_URL, SUPABASE_KEY)
  .from("items")
  .url.toString().length

/**
 * A dense `1..n` id list whose rendered `in(...)` filter, combined with the
 * base table URL, is at least `minLength` characters — i.e. the URL a single,
 * unsplit request for this list would produce. Sized against `MAX_URL_LENGTH`
 * (rather than a hard-coded id count) so the tests below keep exercising the
 * splitter even if that constant ever changes.
 *
 * A small sample list's rendered length estimates the average per-id cost
 * (digits plus a percent-encoded comma); the list is then resized to that
 * estimate. One correction pass is always enough — the only thing the sample
 * can get wrong is the id width, which grows by at most a digit or two
 * between the sample and the final count.
 */
function idsExceedingLength(minLength: number): number[] {
  let count = 100
  for (let attempt = 0; attempt < 10; attempt++) {
    const ids = Array.from({ length: count }, (_, i) => i + 1)
    const length =
      BASE_URL_LENGTH +
      loadSubsetOptionsToSearch({
        where: inArray(idRef, ids),
      } as unknown as LoadSubsetOptions).toString().length
    if (length >= minLength) {
      return ids
    }
    const perId = (length - BASE_URL_LENGTH) / count
    count = Math.ceil((minLength - BASE_URL_LENGTH) / perId) + 10
  }
  throw new Error(`could not size an id list past ${minLength} characters`)
}

const run = (
  mockFetch: ReturnType<typeof makePaginatingFetch> | typeof fetch,
  ids: number[],
  signal: AbortSignal = new AbortController().signal
) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: mockFetch },
  })
  return supabaseQueryFn(supabase, "items", {
    client: new QueryClient(),
    queryKey: ["items"],
    signal,
    meta: { loadSubsetOptions: { where: inArray(idRef, ids) } } as never,
  })
}

describe("supabaseQueryFn: chunked fan-out for an oversized IN list", () => {
  test("many ids produce multiple requests, every URL within budget, and every matching row comes back", async () => {
    const ids = idsExceedingLength(MAX_URL_LENGTH * 1.5)
    const fixture = ids.map((id) => ({ id }))
    const mockFetch = makePaginatingFetch(fixture)

    const rows = await run(mockFetch, ids)

    expect(
      (rows as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b)
    ).toEqual(ids)
    const searches = getSearches(mockFetch)
    // The list does not fit in one request at this budget, so it was split.
    expect(searches.length).toBeGreaterThan(1)
    // Every request the mock saw actually carried an `in.(...)` slice of the
    // original list, proving the split happened on the `id` column.
    for (const search of searches) {
      expect(search).toMatch(/id=in\.\(/)
    }
    // Every rendered request line stays within the fixed budget.
    for (const rawUrl of getRawUrls(mockFetch)) {
      expect(rawUrl.length).toBeLessThanOrEqual(MAX_URL_LENGTH + 1)
    }
  })

  test("splitting and the db-max-rows cap compose: a chunk larger than the cap still pages", async () => {
    const ids = idsExceedingLength(MAX_URL_LENGTH * 1.5)
    const fixture = ids.map((id) => ({ id }))
    // Small enough that each chunk (hundreds to low thousands of ids) needs
    // several pages, but not so small that the paging loop needs thousands of
    // requests to get through a chunk.
    const cap = 100
    const mockFetch = makePaginatingFetch(fixture, { cap })

    const rows = await run(mockFetch, ids)

    const returned = (rows as Array<{ id: number }>).map((r) => r.id)
    expect(returned.sort((a, b) => a - b)).toEqual(ids)
    expect(new Set(returned).size).toBe(ids.length)
    const searches = getSearches(mockFetch)
    // More requests than there are chunks: each chunk's own paging loop ran.
    expect(searches.length).toBeGreaterThan(2)
  })

  test("one failing chunk rejects the load and aborts its sibling requests", async () => {
    const ids = idsExceedingLength(MAX_URL_LENGTH * 3)
    // Any id lands in exactly one chunk (chunks are disjoint slices of the
    // sorted list), so failing whichever chunk holds this one exercises the
    // abort path without depending on how many chunks came out.
    const failId = ids[0]
    let abortedCount = 0

    const failingFetch = vi
      .fn<typeof fetch>()
      .mockImplementation((input, init) => {
        const params = new URL(String(input)).searchParams
        const idFilter = params.get("id") ?? ""
        const members = idFilter
          .replace(/^in\.\(/, "")
          .replace(/\)$/, "")
          .split(",")
          .map(Number)
        // The chunk holding `failId` fails fast; every other chunk is slow
        // enough that the abort raised by the failure reaches it first.
        const isFailingChunk = members.includes(failId)
        const signal = init?.signal as AbortSignal | undefined

        return new Promise<Response>((resolve, reject) => {
          const settle = () => {
            if (isFailingChunk) {
              resolve(
                new Response(JSON.stringify({ message: "boom" }), {
                  status: 500,
                  headers: { "content-type": "application/json" },
                })
              )
              return
            }
            resolve(
              new Response(JSON.stringify([]), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "content-range": "*/0",
                },
              })
            )
          }
          const timer = setTimeout(settle, isFailingChunk ? 0 : 50)
          signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            abortedCount += 1
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      })

    await expect(run(failingFetch, ids)).rejects.toBeDefined()
    // Give the aborted siblings' rejection handlers a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(abortedCount).toBeGreaterThan(0)
  })

  test("concurrency never exceeds the fan-out's concurrency cap", async () => {
    // MAX_CONCURRENT_CHUNKS (src/functions.ts) is 6; size the list well past
    // that so the cap actually binds instead of every chunk fitting in one
    // wave.
    const ids = idsExceedingLength(MAX_URL_LENGTH * 10)
    const fixture = ids.map((id) => ({ id }))
    const base = makePaginatingFetch(fixture)

    let active = 0
    let peak = 0
    const trackedFetch = vi.fn<typeof fetch>(async (input, init) => {
      active += 1
      peak = Math.max(peak, active)
      // Yield so overlapping calls actually overlap instead of resolving
      // synchronously one at a time.
      await new Promise((resolve) => setTimeout(resolve, 5))
      try {
        return await base(input, init)
      } finally {
        active -= 1
      }
    })

    const rows = await run(trackedFetch, ids)

    expect((rows as Array<{ id: number }>).length).toBe(ids.length)
    const searches = getSearches(trackedFetch)
    // Sizing above actually produced more chunks than the concurrency cap.
    expect(searches.length).toBeGreaterThan(6)
    // MAX_CONCURRENT_CHUNKS in src/functions.ts.
    expect(peak).toBeLessThanOrEqual(6)
    // The cap should actually bind here — otherwise this test would not have
    // exercised the concurrency limiter at all.
    expect(peak).toBeGreaterThan(1)
  })
})
