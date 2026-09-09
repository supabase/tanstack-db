import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { BaseQueryBuilder, IR } from "@tanstack/db"
import { and, eq, gt, not, Query } from "@tanstack/db"
import { beforeEach, describe, expect, test } from "vitest"
import { subsetOptionsToQueryKey, supabaseQueryFn } from "../src/functions"
import {
  createMockedUsersCollection,
  createMockFetch,
  expectFetchUrls,
  SUPABASE_KEY,
  SUPABASE_URL,
} from "./test.utils"

// Pull a parsed WHERE expression out of the query builder so we can feed it to
// supabaseQueryFn / subsetOptionsToQueryKey the way the collection does.
function whereOf(
  build: (q: ReturnType<typeof usersFrom>) => unknown
): IR.BasicExpression<boolean> {
  const built = build(usersFrom())
  const where = (built as unknown as BaseQueryBuilder)._getQuery().where?.[0] as
    | IR.BasicExpression<boolean>
    | undefined
  if (!where) {
    throw new Error("expected a where clause")
  }
  return where
}

function usersFrom() {
  const usersCollection = createMockedUsersCollection(createMockFetch())
  return new Query().from({ user: usersCollection })
}

describe("supabaseQueryFn", () => {
  let mockFetch: ReturnType<typeof createMockFetch>
  let supabase: SupabaseClient

  beforeEach(() => {
    mockFetch = createMockFetch()
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
  })

  function run(loadSubsetOptions: Record<string, unknown>) {
    return supabaseQueryFn(supabase, "users", {
      client: {} as never,
      queryKey: ["users"],
      signal: new AbortController().signal,
      meta: { loadSubsetOptions } as never,
    })
  }

  // Regression: offset previously used a hard-coded range(offset, offset + 5),
  // capping every paged request at 6 rows regardless of limit.
  test("offset uses a limit-sized inclusive range, not a fixed window", async () => {
    await run({ limit: 20, offset: 20 })
    expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&limit=20&offset=20"])
  })

  test("offset without an explicit limit falls back to the default page size", async () => {
    await run({ offset: 10 })
    expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&limit=1000&offset=10"])
  })
})

describe("subsetOptionsToQueryKey", () => {
  test("negated clauses produce a distinct cache key from un-negated ones", () => {
    const negated = subsetOptionsToQueryKey("users", {
      where: whereOf((q) => q.where(({ user }) => not(eq(user.active, false)))),
    } as never)
    const plain = subsetOptionsToQueryKey("users", {
      where: whereOf((q) => q.where(({ user }) => eq(user.active, false))),
    } as never)

    expect(negated).not.toEqual(plain)
  })

  test("AND of filters serializes both sides into the key", () => {
    const key = subsetOptionsToQueryKey("users", {
      where: whereOf((q) =>
        q.where(({ user }) => and(eq(user.active, true), gt(user.id, 5)))
      ),
    } as never)
    expect(JSON.stringify(key)).toContain("active=eq.true")
    expect(JSON.stringify(key)).toContain("id=gt.5")
  })
})
