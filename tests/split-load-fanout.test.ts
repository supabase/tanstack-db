import { createClient } from "@supabase/supabase-js"
import { IR, inArray } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { describe, expect, test, vi } from "vitest"
import { supabaseQueryFn } from "../src/functions"
import {
  getRawUrls,
  getSearches,
  makePaginatingFetch,
} from "./pagination.utils"
import { SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

// Same table shape `makePaginatingFetch` was built for: a bare numeric `id`.
const idRef = new IR.PropRef<number>(["id"])

const run = (
  mockFetch: ReturnType<typeof makePaginatingFetch> | typeof fetch,
  ids: number[],
  maxUrlLength: number,
  signal: AbortSignal = new AbortController().signal
) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: mockFetch },
  })
  return supabaseQueryFn(
    supabase,
    "items",
    {
      client: new QueryClient(),
      queryKey: ["items"],
      signal,
      meta: { loadSubsetOptions: { where: inArray(idRef, ids) } } as never,
    },
    { maxUrlLength }
  )
}

describe("supabaseQueryFn: chunked fan-out for an oversized IN list", () => {
  test("many ids produce multiple requests, every URL within budget, and every matching row comes back", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1)
    const fixture = ids.map((id) => ({ id }))
    const mockFetch = makePaginatingFetch(fixture)
    const maxUrlLength = 100

    const rows = await run(mockFetch, ids, maxUrlLength)

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
    // The budget is measured against `base URL + rendered search string`
    // (no separator); the real request URL adds one `?` on top of that, so
    // the wire length is at most one character longer than the budget.
    for (const rawUrl of getRawUrls(mockFetch)) {
      expect(rawUrl.length).toBeLessThanOrEqual(maxUrlLength + 1)
    }
  })

  test("splitting and the db-max-rows cap compose: a chunk larger than the cap still pages", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1)
    const fixture = ids.map((id) => ({ id }))
    // Fits ~20 ids per chunk, so two chunks of 20 — each well above the cap.
    const maxUrlLength = 145
    const cap = 7
    const mockFetch = makePaginatingFetch(fixture, { cap })

    const rows = await run(mockFetch, ids, maxUrlLength)

    const returned = (rows as Array<{ id: number }>).map((r) => r.id)
    expect(returned.sort((a, b) => a - b)).toEqual(ids)
    expect(new Set(returned).size).toBe(ids.length)
    // More requests than there are chunks: each chunk's own paging loop ran.
    expect(getSearches(mockFetch).length).toBeGreaterThan(2)
  })

  test("one failing chunk rejects the load and aborts its sibling requests", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => i + 1)
    // Fits two ids per request, so four chunks are issued concurrently
    // (well under MAX_CONCURRENT_CHUNKS).
    const maxUrlLength = 62
    let abortedCount = 0

    const failingFetch = vi
      .fn<typeof fetch>()
      .mockImplementation((input, init) => {
        const params = new URL(String(input)).searchParams
        const idFilter = params.get("id") ?? ""
        // The chunk holding id 3 fails fast; every other chunk is slow enough
        // that the abort raised by the failure reaches it first.
        const isFailingChunk = idFilter.includes("3")
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

    await expect(run(failingFetch, ids, maxUrlLength)).rejects.toBeDefined()
    // Give the aborted siblings' rejection handlers a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(abortedCount).toBeGreaterThan(0)
  })

  test("concurrency never exceeds the fan-out's concurrency cap", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1)
    const fixture = ids.map((id) => ({ id }))
    // Two ids per request => 15 chunks, comfortably more than the cap.
    const maxUrlLength = 62
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

    const rows = await run(trackedFetch, ids, maxUrlLength)

    expect((rows as Array<{ id: number }>).length).toBe(ids.length)
    // MAX_CONCURRENT_CHUNKS in src/functions.ts.
    expect(peak).toBeLessThanOrEqual(6)
    // The cap should actually bind here — otherwise this test would not have
    // exercised the concurrency limiter at all.
    expect(peak).toBeGreaterThan(1)
  })
})
