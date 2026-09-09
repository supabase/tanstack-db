import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { BaseQueryBuilder, IR } from "@tanstack/db"
import { eq, Query } from "@tanstack/db"
import { describe, expect, test, vi } from "vitest"
import { supabaseQueryFn } from "../src/functions"
import {
  createMockedUsersCollection,
  createMockFetch,
  normalizeFetchUrl,
  SUPABASE_KEY,
  SUPABASE_URL,
} from "./test.utils"

interface TestRow {
  active: boolean
  email: string
  id: number
  name: string
}

const makeRows = (count: number): TestRow[] =>
  Array.from({ length: count }, (_, id) => ({
    active: true,
    email: `user-${id}@test.com`,
    id,
    name: `User ${id}`,
  }))

const createPagedFetch = (
  rows: TestRow[],
  {
    errorOffset,
    maxRows = 1000,
  }: { errorOffset?: number; maxRows?: number } = {}
) =>
  vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(typeof input === "string" ? input : input.toString())
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const requestedLimit = Number(url.searchParams.get("limit") ?? maxRows)
    const limit = Math.min(requestedLimit, maxRows)

    if (offset === errorOffset) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: "PGRST000",
            details: null,
            hint: null,
            message: "page failed",
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          }
        )
      )
    }

    return Promise.resolve(
      new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  })

const runQuery = (
  supabase: SupabaseClient,
  loadSubsetOptions: Record<string, unknown> = {},
  pageSize?: number
) =>
  supabaseQueryFn(
    supabase,
    "users",
    {
      client: {} as never,
      queryKey: ["users"],
      signal: new AbortController().signal,
      meta: { loadSubsetOptions } as never,
    },
    pageSize
  )

const queryOptions = (): {
  orderBy: unknown
  where: IR.BasicExpression<boolean>
} => {
  const collection = createMockedUsersCollection(createMockFetch())
  const query = new Query()
    .from({ user: collection })
    .where(({ user }) => eq(user.active, true))
    .orderBy(({ user }) => user.id)
  const built = (query as unknown as BaseQueryBuilder)._getQuery()
  collection.cleanup()

  return {
    orderBy: built.orderBy,
    where: built.where?.[0] as IR.BasicExpression<boolean>,
  }
}

describe("collection query pagination", () => {
  test("fetches all rows across multiple PostgREST pages", async () => {
    const mockFetch = createPagedFetch(makeRows(2501))
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    const rows = await runQuery(supabase)

    expect(rows).toHaveLength(2501)
    expect(mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))).toEqual(
      [
        "/rest/v1/users?select=*",
        "/rest/v1/users?limit=1000&offset=1000&select=*",
        "/rest/v1/users?limit=1000&offset=2000&select=*",
      ]
    )
  })

  test("preserves filters, ordering, limits, and offsets on every page", async () => {
    const mockFetch = createPagedFetch(makeRows(12), { maxRows: 2 })
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    const rows = await runQuery(
      supabase,
      { ...queryOptions(), limit: 5, offset: 3 },
      2
    )

    expect(rows.map(({ id }) => id)).toEqual([3, 4, 5, 6, 7])
    expect(mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))).toEqual(
      [
        "/rest/v1/users?limit=2&offset=3&order=user.id.asc&select=*&user.active=eq.true",
        "/rest/v1/users?limit=2&offset=5&order=user.id.asc&select=*&user.active=eq.true",
        "/rest/v1/users?limit=1&offset=7&order=user.id.asc&select=*&user.active=eq.true",
      ]
    )
  })

  test("stops after a short final page", async () => {
    const mockFetch = createPagedFetch(makeRows(3), { maxRows: 2 })
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    const rows = await runQuery(supabase, {}, 2)

    expect(rows).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test("does not request beyond an explicit limit", async () => {
    const mockFetch = createPagedFetch(makeRows(8), { maxRows: 2 })
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    const rows = await runQuery(supabase, { limit: 4 }, 2)

    expect(rows).toHaveLength(4)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test("fails the complete load when a later page errors", async () => {
    const mockFetch = createPagedFetch(makeRows(5), {
      errorOffset: 2,
      maxRows: 2,
    })
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    await expect(runQuery(supabase, {}, 2)).rejects.toMatchObject({
      message: "page failed",
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
