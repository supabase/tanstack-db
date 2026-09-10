import {
  and,
  eq,
  gt,
  IR,
  ilike,
  inArray,
  isNull,
  like,
  not,
  or,
  upper,
} from "@tanstack/db"
import { describe, expect, test } from "vitest"
import { subsetOptionsToQueryKey } from "../src/functions"
import {
  loadSubsetOptionsToSearch,
  queryIrToSearch,
} from "../src/postgrest-filters"

// Exercise the pure search builders directly on both paths: the live subset
// loader (`loadSubsetOptionsToSearch`) and the queryOnce IR translator
// (`queryIrToSearch`). They differ in ref shape (aliased on the server),
// IN-merging (live only), and strictness (server rejects unpushable filters).
describe.each([
  "live",
  "server",
] as const)("%s filter serialization", (path) => {
  const ref = (column: string) =>
    new IR.PropRef(path === "server" ? ["user", column] : [column])
  const name = ref("name")
  const id = ref("id")
  const active = ref("active")

  function request(where: IR.BasicExpression<boolean>): URLSearchParams {
    if (path === "server") {
      return queryIrToSearch({
        from: { type: "table", name: "users", alias: "user" },
        where: [where],
      }).search
    }
    return loadSubsetOptionsToSearch({ where })
  }

  test("preserves AND branches inside OR", () => {
    const params = request(
      or(and(eq(active, true), gt(id, 1)), eq(name, "Bob"))
    )
    expect(params.get("or")).toBe("(and(active.eq.true,id.gt.1),name.eq.Bob)")
  })

  test.each([and, or])("negates logical groups", (logical) => {
    const params = request(not(logical(eq(active, true), eq(name, "Bob"))))
    expect(params.get("or")).toBe(
      logical === and
        ? "(active.not.eq.true,name.not.eq.Bob)"
        : "(and(active.not.eq.true,name.not.eq.Bob))"
    )
  })

  test("supports double negation of comparisons and logical groups", () => {
    expect(request(not(not(eq(name, "Alice")))).get("name")).toBe("eq.Alice")
    expect(request(not(not(or(eq(name, "Alice"), eq(id, 2))))).get("or")).toBe(
      "(name.eq.Alice,id.eq.2)"
    )
  })

  test("preserves multiple OR parameters under AND", () => {
    const params = request(
      and(or(eq(id, 1), eq(id, 2)), or(eq(name, "Alice"), eq(name, "Bob")))
    )
    expect(params.getAll("or")).toEqual([
      "(id.eq.1,id.eq.2)",
      "(name.eq.Alice,name.eq.Bob)",
    ])
  })

  test.each([
    ["", '""'],
    [" a ", '" a "'],
    ["a,b(c)", '"a,b(c)"'],
    ['a"b\\c', '"a\\"b\\\\c"'],
    ["a.b:c&d=1+%", "a.b:c&d=1+%"],
  ])("quotes logical values and IN members: %j", (value, quoted) => {
    expect(request(or(eq(name, value), eq(id, 2))).get("or")).toBe(
      `(name.eq.${quoted},id.eq.2)`
    )
    expect(request(inArray(name, [value, value])).get("name")).toBe(
      value === "" ? "eq." : `in.(${quoted})`
    )
    expect(request(not(inArray(name, [value]))).get("name")).toBe(
      value === "" ? "not.eq." : `not.in.(${quoted})`
    )
    expect(request(eq(name, value)).get("name")).toBe(`eq.${value}`)
    expect(request(not(eq(name, value))).get("name")).toBe(`not.eq.${value}`)
  })

  test("renders negated comparisons inside OR", () => {
    const params = request(
      or(not(isNull(name)), not(inArray(name, ["a,b", "c"])))
    )
    expect(params.get("or")).toBe('(name.not.is.null,name.not.in.("a,b",c))')
  })

  test("does not union IN constraints inside logical groups", () => {
    const params = request(
      or(and(inArray(id, [1, 2]), inArray(id, [2, 3])), eq(active, true))
    )
    expect(params.get("or")).toBe(
      "(and(id.in.(1,2),id.in.(2,3)),active.eq.true)"
    )
  })

  test("merges top-level IN demands only for live queries without mutating IR", () => {
    const where = and(
      inArray(id, [1, 2]),
      and(inArray(id, [2, 3]), eq(active, true))
    )
    const before = JSON.stringify(where)
    expect(request(where).getAll("id")).toEqual(
      path === "live" ? ["in.(1,2,3)"] : ["in.(1,2)", "in.(2,3)"]
    )
    expect(JSON.stringify(where)).toBe(before)
  })

  test("renders empty IN lists with SQL null semantics", () => {
    expect(request(inArray(id, [])).get("id")).toBe("in.()")
    expect(request(not(inArray(id, []))).get("id")).toBe("not.is.null")
    expect(request(not(not(inArray(id, [])))).get("id")).toBe("in.()")
  })

  test("preserves null guards for empty IN inside a negated logical group", () => {
    const params = request(not(and(inArray(name, []), eq(active, true))))
    expect(params.get("or")).toBe("(name.not.is.null,active.not.eq.true)")
  })

  test("ignores null list members instead of matching literal null strings", () => {
    expect(request(inArray(name, ["Alice", null])).get("name")).toBe(
      "in.(Alice)"
    )
    expect(request(not(inArray(name, ["Alice", null]))).get("name")).toBe(
      "not.in.(Alice)"
    )
    expect(request(not(inArray(name, [null]))).get("name")).toBe("not.is.null")
  })

  test.each([
    like,
    ilike,
  ])("preserves SQL wildcards and literal backslashes", (match) => {
    expect(request(match(name, "A_%")).get("name")).toBe(
      `${match === like ? "like" : "ilike"}.A_%`
    )
    expect(request(not(match(name, "a\\%"))).get("name")).toBe(
      `not.${match === like ? "like" : "ilike"}.a\\\\%`
    )
  })

  test.each([
    ["computed OR", or(eq(active, true), eq(upper(name), "ALICE"))],
    ["computed NOT AND", not(and(eq(active, true), eq(upper(name), "ALICE")))],
    ["literal asterisk", like(name, "*Ali*")],
    ["negated literal asterisk", not(ilike(name, "*Ali*"))],
  ])("handles unsupported %s without narrowing results", (_, where) => {
    if (path === "server") {
      expect(() => request(where)).toThrow("fully pushable filters")
    } else {
      const params = request(and(gt(id, 0), where))
      expect([...params]).toEqual([
        ["select", "*"],
        ["id", "gt.0"],
      ])
    }
  })
})

describe("filter cache keys", () => {
  const name = new IR.PropRef<string>(["name"])
  const active = new IR.PropRef<boolean>(["active"])
  const key = (where: IR.BasicExpression<boolean>) =>
    subsetOptionsToQueryKey("users", { where })

  test("literal query delimiters cannot collide with extra filters", () => {
    expect(key(eq(name, "Alice&active=eq.true"))).not.toEqual(
      key(and(eq(name, "Alice"), eq(active, true)))
    )
  })

  test("distinguishes NOT, OR branches, and IN list boundaries", () => {
    expect(key(eq(name, "Alice"))).not.toEqual(key(not(eq(name, "Alice"))))
    expect(key(or(eq(name, "Alice"), eq(active, true)))).not.toEqual(
      key(or(eq(name, "Bob"), eq(active, true)))
    )
    expect(key(inArray(name, ["a,b", "c"]))).not.toEqual(
      key(inArray(name, ["a", "b,c"]))
    )
  })

  test("uses the merged IN request and omits unpushable OR groups", () => {
    expect(
      key(and(inArray(name, ["a", "b"]), inArray(name, ["b", "c"])))
    ).toEqual(key(inArray(name, ["a", "b", "c"])))
    expect(key(or(eq(name, "Alice"), eq(upper(name), "BOB")))).toEqual([
      "users",
    ])
  })
})
