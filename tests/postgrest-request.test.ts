import { createClient } from "@supabase/supabase-js"
import { and, eq, gt, IR } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { describe, expect, test } from "vitest"
import { supabaseQueryFn } from "../src/functions"
import {
  appendOrder,
  cursorToPostgrestParams,
  paramsToKey,
  paramsToSearch,
  toPostgrestParams,
} from "../src/postgrest-filters"
import { buildSupabaseQuery } from "../src/query-once"
import { createMockFetch, SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

describe("request-state escape hatch", () => {
  // supabase-js changing these fields would silently drop auth; fail loudly.
  test("supabase.from(table) exposes url, headers, and fetch", () => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const qb = supabase.from("users")
    expect(qb.url).toBeInstanceOf(URL)
    expect(qb.url.toString()).toBe(`${SUPABASE_URL}/rest/v1/users`)
    expect(qb.headers).toBeInstanceOf(Headers)
    expect(typeof qb.fetch).toBe("function")
  })
})

describe("param helpers", () => {
  test("appendOrder merges multiple sorts into one comma-joined value", () => {
    const search = new URLSearchParams()
    appendOrder(search, [
      { column: "id", ascending: true },
      { column: "name", ascending: false },
    ])
    expect(search.get("order")).toBe("id.asc,name.desc")
    expect(search.getAll("order")).toHaveLength(1)
  })

  test("cursorToPostgrestParams quotes IN members and leaves scalars raw", () => {
    const params = cursorToPostgrestParams([
      { field: ["name"], operator: "in", value: ["a,b", "c"] },
      { field: ["id"], operator: "gt", value: 5 },
      { field: ["deleted_at"], operator: "isNull" },
    ])
    expect(paramsToKey(params)).toBe(
      new URLSearchParams([
        ["name", 'in.("a,b",c)'],
        ["id", "gt.5"],
        ["deleted_at", "is.null"],
      ]).toString()
    )
  })
})

describe("offset without limit", () => {
  test("buildSupabaseQuery emits offset independently of limit", () => {
    const { search } = buildSupabaseQuery(
      createClient(SUPABASE_URL, SUPABASE_KEY),
      {
        from: { type: "table", name: "users", alias: "user" },
        offset: 20,
      }
    )
    expect(search.get("offset")).toBe("20")
    expect(search.has("limit")).toBe(false)
  })
})

describe("query key matches request URL", () => {
  test("the cache key filters string equals the sent search string", async () => {
    const name = new IR.PropRef<string>(["name"])
    const id = new IR.PropRef<number>(["id"])
    const where = and(eq(name, "Alice&x=1"), gt(id, 3))

    const key = paramsToKey(toPostgrestParams(where, { mergeIn: true }))
    const requestSearch = paramsToSearch(
      toPostgrestParams(where, { mergeIn: true })
    ).toString()
    expect(key).toBe(requestSearch)

    const mockFetch = createMockFetch()
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
    await supabaseQueryFn(supabase, "users", {
      client: new QueryClient(),
      queryKey: ["users"],
      signal: new AbortController().signal,
      meta: { loadSubsetOptions: { where } },
    })
    const sent = new URL(String(mockFetch.mock.calls[0][0])).searchParams
    sent.delete("select")
    // Every filter param in the key is present verbatim in the request.
    for (const [k, v] of new URLSearchParams(key)) {
      expect(sent.getAll(k)).toContain(v)
    }
  })
})
