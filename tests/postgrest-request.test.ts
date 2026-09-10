import { createClient } from "@supabase/supabase-js"
import { and, eq, gt, IR, inArray } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { describe, expect, test } from "vitest"
import { subsetOptionsToQueryKey, supabaseQueryFn } from "../src/functions"
import {
  keyColumnsToSearch,
  loadSubsetOptionsToSearch,
  queryIrToSearch,
} from "../src/postgrest-filters"
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

describe("queryIrToSearch", () => {
  test("merges multiple orderBy into one comma-joined order", () => {
    const { search } = queryIrToSearch({
      from: { type: "table", name: "users", alias: "user" },
      orderBy: [
        {
          expression: { type: "ref", path: ["user", "id"] },
          direction: "asc",
          nulls: "last",
        },
        {
          expression: { type: "ref", path: ["user", "name"] },
          direction: "desc",
          nulls: "last",
        },
      ],
    })
    expect(search.get("order")).toBe("id.asc,name.desc")
    expect(search.getAll("order")).toHaveLength(1)
  })

  test("emits offset independently of limit", () => {
    const { search } = queryIrToSearch({
      from: { type: "table", name: "users", alias: "user" },
      offset: 20,
    })
    expect(search.get("offset")).toBe("20")
    expect(search.has("limit")).toBe(false)
  })
})

describe("loadSubsetOptionsToSearch", () => {
  test("quotes cursor IN members", () => {
    const name = new IR.PropRef<string>(["name"])
    const search = loadSubsetOptionsToSearch({
      cursor: {
        whereFrom: inArray(name, ["a,b", "c"]),
        whereCurrent: eq(name, "z"),
      },
    })
    expect(search.get("name")).toBe('in.("a,b",c)')
  })
})

describe("keyColumnsToSearch", () => {
  test("builds an eq filter per key column", () => {
    const search = keyColumnsToSearch(["user_id", "todo_id"], {
      user_id: 1,
      todo_id: 2,
      title: "ignored",
    })
    expect(search.get("user_id")).toBe("eq.1")
    expect(search.get("todo_id")).toBe("eq.2")
    expect([...search.keys()]).toEqual(["user_id", "todo_id"])
  })
})

describe("query key matches request URL", () => {
  test("the cache key encodes the same filters as the sent request", async () => {
    const name = new IR.PropRef<string>(["name"])
    const id = new IR.PropRef<number>(["id"])
    const where = and(eq(name, "Alice&x=1"), gt(id, 3))

    const [, keyString] = subsetOptionsToQueryKey("users", { where })

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
    for (const [key, value] of new URLSearchParams(keyString)) {
      expect(sent.getAll(key)).toContain(value)
    }
  })
})
