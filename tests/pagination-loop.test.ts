import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { eq, IR, type LoadSubsetOptions } from "@tanstack/db"
import { describe, expect, test, vi } from "vitest"
import { supabaseQueryFn } from "../src/functions"
import { normalizeFetchUrl, SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

interface TestRow {
  active: boolean
  email: string
  id: number
  name: string
  [key: string]: unknown
}

type Row = Record<string, unknown>

const makeRows = (count: number): TestRow[] =>
  Array.from({ length: count }, (_, id) => ({
    active: true,
    email: `user-${id}@test.com`,
    id,
    name: `User ${id}`,
  }))

// ── A small PostgREST-like mock ──────────────────────────────────────
// Parses `order` and simple top-level `col=eq.value` filters with the same
// typing PostgREST would use, then slices by offset/limit (capped at the
// simulated server row cap) and reports `Content-Range` for the filtered
// total, matching what a real `count=exact` request returns. A request with no
// `limit` param is served the whole page the server would return — up to the
// row cap — exactly as PostgREST does when the client sends no limit.

const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset"])

const compareValues = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") {
    if (a === b) return 0
    return a ? 1 : -1
  }
  const left = String(a)
  const right = String(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const unquote = (raw: string): string => {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1")
  }
  return raw
}

const coerce = (raw: string, sample: unknown): unknown => {
  if (typeof sample === "number") return Number(raw)
  if (typeof sample === "boolean") return raw === "true"
  return unquote(raw)
}

type Predicate = (row: Row) => boolean

const parseLeaf = (token: string): Predicate => {
  const firstDot = token.indexOf(".")
  const column = token.slice(0, firstDot)
  const rest = token.slice(firstDot + 1)
  if (rest === "is.null") {
    return (row) => row[column] === null
  }
  if (rest === "not.is.null") {
    return (row) => row[column] !== null
  }
  const opDot = rest.indexOf(".")
  const op = rest.slice(0, opDot)
  const rawValue = rest.slice(opDot + 1)
  return (row) => {
    const sample = row[column]
    const value = coerce(rawValue, sample)
    if (op === "eq") return sample === value
    if (op === "gt") return (sample as never) > (value as never)
    if (op === "lt") return (sample as never) < (value as never)
    throw new Error(`unsupported operator in test mock: ${op}`)
  }
}

const parseOrder = (
  orderParam: string | null
): Array<{ ascending: boolean; column: string }> => {
  if (!orderParam) return []
  return orderParam.split(",").map((part) => {
    const [column, direction] = part.split(".")
    return { ascending: direction !== "desc", column }
  })
}

const sortRows = <T extends Row>(
  rows: T[],
  order: ReturnType<typeof parseOrder>
): T[] =>
  [...rows].sort((a, b) => {
    for (const { ascending, column } of order) {
      const cmp = compareValues(a[column], b[column])
      if (cmp !== 0) return ascending ? cmp : -cmp
    }
    return 0
  })

const createPagedFetch = <T extends Row>(
  rows: T[],
  {
    errorOnRequest,
    maxRows = 1000,
    omitCount = false,
    onRequest,
  }: {
    errorOnRequest?: number
    maxRows?: number
    omitCount?: boolean
    onRequest?: (index: number) => void
  } = {}
) => {
  let requestCount = -1
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    requestCount += 1
    const index = requestCount
    onRequest?.(index)

    const url = new URL(typeof input === "string" ? input : input.toString())
    const params = url.searchParams

    if (index === errorOnRequest) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "PGRST000",
            details: null,
            hint: null,
            message: "page failed",
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      )
    }

    let filtered = rows.filter((row) => {
      for (const [key, value] of params.entries()) {
        if (RESERVED_PARAMS.has(key)) continue
        if (!parseLeaf(`${key}.${value}`)(row)) return false
      }
      return true
    })

    filtered = sortRows(filtered, parseOrder(params.get("order")))

    const total = filtered.length
    const offset = Number(params.get("offset") ?? 0)
    // No `limit` param means the client left the page size to the server, which
    // still caps the response at `maxRows`.
    const requestedLimit = Number(params.get("limit") ?? maxRows)
    const limit = Math.min(requestedLimit, maxRows)
    const page = filtered.slice(offset, offset + limit)

    const headers: Record<string, string> = {
      "content-type": "application/json",
    }
    if (!omitCount) {
      headers["content-range"] =
        page.length === 0
          ? `*/${total}`
          : `${offset}-${offset + page.length - 1}/${total}`
    }

    return Promise.resolve(
      new Response(JSON.stringify(page), { status: 200, headers })
    )
  })
}

const runQuery = (
  supabase: SupabaseClient,
  loadSubsetOptions: LoadSubsetOptions = {},
  keys = ["id"],
  signal: AbortSignal = new AbortController().signal
) =>
  supabaseQueryFn(supabase, "users", keys, {
    client: {} as never,
    queryKey: ["users"],
    signal,
    meta: { loadSubsetOptions },
  })

const sort = (column: string, direction: "asc" | "desc" = "asc") => ({
  expression: new IR.PropRef([column]),
  compareOptions: { direction, nulls: "last" as const },
})

const queryOptions = (): LoadSubsetOptions => ({
  orderBy: [sort("id")],
  where: eq(new IR.PropRef<boolean>(["active"]), true),
})

const supabaseWithFetch = (mockFetch: typeof fetch) =>
  createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: mockFetch } })

describe("collection query pagination", () => {
  test("pages by the server row cap when no limit is requested", async () => {
    const expected = makeRows(3000)
    const mockFetch = createPagedFetch(expected, { maxRows: 500 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase)

    expect(rows).toEqual(expected)
    expect(mockFetch).toHaveBeenCalledTimes(6)
    // No `limit` param is ever sent; the server's max-rows setting alone sizes
    // each page.
    for (const [url] of mockFetch.mock.calls) {
      expect(new URL(String(url)).searchParams.has("limit")).toBe(false)
    }
    // Each page returns 500 rows (the cap), so the offset must advance by rows
    // actually received or the next page would skip rows.
    expect(
      mockFetch.mock.calls.map(([url]) =>
        new URL(String(url)).searchParams.get("offset")
      )
    ).toEqual([null, "500", "1000", "1500", "2000", "2500"])
  })

  test("stops without an extra request when the count is an exact multiple of the cap", async () => {
    const expected = makeRows(2000)
    const mockFetch = createPagedFetch(expected, { maxRows: 1000 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase)

    expect(rows).toEqual(expected)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(
      mockFetch.mock.calls.map(([url]) =>
        new URL(String(url)).searchParams.get("offset")
      )
    ).toEqual([null, "1000"])
  })

  test("loads only the first server page when no count header is returned", async () => {
    // Without a count and without a caller limit there is no signal that more
    // rows remain, so the loop cannot safely advance the offset — it treats the
    // single server page as complete. (A real PostgREST always reports the range
    // under `count=exact`, so this is only a defensive fallback.)
    const expected = makeRows(3000)
    const mockFetch = createPagedFetch(expected, {
      maxRows: 500,
      omitCount: true,
    })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase)

    expect(rows).toHaveLength(500)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test.each([
    { keys: ["id"], orderBy: undefined, expected: "id.asc" },
    {
      keys: ["id"],
      orderBy: [sort("active", "desc")],
      expected: "active.desc,id.asc",
    },
    {
      keys: ["id"],
      orderBy: [sort("active"), sort("id", "desc")],
      expected: "active.asc,id.desc",
    },
    {
      keys: ["email", "id"],
      orderBy: undefined,
      expected: "email.asc,id.asc",
    },
    {
      keys: ["email", "id"],
      orderBy: [sort("email", "desc")],
      expected: "email.desc,id.asc",
    },
  ])("uses unique ordering $expected on every page", async ({
    keys,
    orderBy,
    expected,
  }) => {
    const mockFetch = createPagedFetch(makeRows(5), { maxRows: 2 })
    const supabase = supabaseWithFetch(mockFetch)

    await runQuery(supabase, { orderBy }, keys)

    expect(mockFetch).toHaveBeenCalledTimes(3)
    for (const [url] of mockFetch.mock.calls) {
      expect(new URL(String(url)).searchParams.get("order")).toBe(expected)
    }
  })

  test("fetches all rows across multiple server pages", async () => {
    const mockFetch = createPagedFetch(makeRows(2501), { maxRows: 1000 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase)

    expect(rows).toHaveLength(2501)
    expect(mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))).toEqual(
      [
        "/rest/v1/users?order=id.asc&select=*",
        "/rest/v1/users?offset=1000&order=id.asc&select=*",
        "/rest/v1/users?offset=2000&order=id.asc&select=*",
      ]
    )
  })

  test("preserves filters, ordering, the caller limit, and offsets on every page", async () => {
    const mockFetch = createPagedFetch(makeRows(12), { maxRows: 2 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase, {
      ...queryOptions(),
      limit: 5,
      offset: 3,
    })

    expect(rows.map(({ id }) => id)).toEqual([3, 4, 5, 6, 7])
    // The caller's remaining limit rides on every page; the offset advances by
    // rows received so the server cap does not leave a gap.
    expect(mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))).toEqual(
      [
        "/rest/v1/users?active=eq.true&limit=5&offset=3&order=id.asc&select=*",
        "/rest/v1/users?active=eq.true&limit=3&offset=5&order=id.asc&select=*",
        "/rest/v1/users?active=eq.true&limit=1&offset=7&order=id.asc&select=*",
      ]
    )
  })

  test("stops after a short final page", async () => {
    const mockFetch = createPagedFetch(makeRows(3), { maxRows: 2 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase)

    expect(rows).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test("does not request beyond an explicit limit", async () => {
    const mockFetch = createPagedFetch(makeRows(8), { maxRows: 2 })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase, { limit: 4 })

    expect(rows).toHaveLength(4)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test("stops on an under-full page under an explicit limit with no count", async () => {
    const mockFetch = createPagedFetch(makeRows(3), {
      maxRows: 10,
      omitCount: true,
    })
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase, { limit: 4 })

    expect(rows).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test("returns no rows and makes no request for limit 0", async () => {
    const mockFetch = createPagedFetch(makeRows(8))
    const supabase = supabaseWithFetch(mockFetch)

    const rows = await runQuery(supabase, { limit: 0 })

    expect(rows).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test("sends Prefer: count=exact on every page", async () => {
    const mockFetch = createPagedFetch(makeRows(5), { maxRows: 2 })
    const supabase = supabaseWithFetch(mockFetch)

    await runQuery(supabase)

    expect(mockFetch.mock.calls.length).toBeGreaterThan(0)
    for (const [, init] of mockFetch.mock.calls) {
      const headers = new Headers(
        init?.headers as ConstructorParameters<typeof Headers>[0]
      )
      expect(headers.get("prefer")).toContain("count=exact")
    }
  })

  test("stops issuing requests once the signal is aborted", async () => {
    const controller = new AbortController()
    const mockFetch = createPagedFetch(makeRows(10), {
      maxRows: 2,
      onRequest: (index) => {
        if (index === 0) controller.abort()
      },
    })
    const supabase = supabaseWithFetch(mockFetch)

    await expect(
      runQuery(supabase, {}, ["id"], controller.signal)
    ).rejects.toBeTruthy()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test("fails the complete load when a later page errors", async () => {
    const mockFetch = createPagedFetch(makeRows(5), {
      maxRows: 2,
      errorOnRequest: 1,
    })
    const supabase = supabaseWithFetch(mockFetch)

    await expect(runQuery(supabase)).rejects.toMatchObject({
      message: "page failed",
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
