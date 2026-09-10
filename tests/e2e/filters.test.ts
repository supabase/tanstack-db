import { and, eq, IR, ilike, inArray, like, not, or, upper } from "@tanstack/db"
import { expect } from "vitest"
import { queryOnce } from "../../src/index"
import { executeQuery } from "../../src/query-once"
import { test } from "./e2e.utils"

const name = new IR.PropRef<string>(["user", "name"])
const active = new IR.PropRef<boolean>(["user", "active"])
const id = new IR.PropRef<number>(["user", "id"])

const cases = [
  ["OR", or(eq(name, "Alice"), eq(name, "Nobody")), ["Alice"]],
  [
    "nested AND/OR",
    or(and(eq(active, true), eq(name, "Bob")), eq(id, 2)),
    ["Bob"],
  ],
  ["NOT AND", not(and(eq(active, true), eq(name, "Alice"))), ["Bob"]],
  ["NOT OR", not(or(eq(active, true), eq(name, "Nobody"))), ["Bob"]],
  ["double NOT", not(not(or(eq(active, true), eq(name, "Nobody")))), ["Alice"]],
  ["LIKE", like(name, "A_i%"), ["Alice"]],
  ["ILIKE", ilike(name, "%ALI%"), ["Alice"]],
  ["NOT LIKE", not(like(name, "A%")), ["Bob"]],
  [
    "OR ILIKE",
    or(ilike(name, "%ali%"), ilike(name, "%bOB%")),
    ["Alice", "Bob"],
  ],
  ["overlapping IN", and(inArray(id, [1, 2]), inArray(id, [2, 3])), ["Bob"]],
  ["empty IN", inArray(id, []), []],
  ["NOT empty IN", not(inArray(id, [])), ["Alice", "Bob"]],
  ["NOT IN with null", not(inArray(name, ["Alice", null])), ["Bob"]],
] as const

// Both routes assert real returned rows, not merely the shape of a URL.
// executeQuery exercises the serializer used for server-side aggregates.
for (const [label, where, expected] of cases) {
  test(`${label} returns matching rows on both query paths`, async ({
    users,
  }) => {
    const liveRows = await queryOnce(
      (q) => q.from({ user: users.collection }).where(() => where),
      users.supabase
    )
    const serverRows = (await executeQuery(users.supabase, {
      from: { type: "table", name: "users", alias: "user" },
      where: [where],
    })) as { name: string }[]
    expect(liveRows.map((row) => row.name).sort()).toEqual(expected)
    expect(serverRows.map((row) => row.name).sort()).toEqual(expected)
  })
}

for (const value of ["", " a ", "a,b(c)", 'a"b\\c', "a.b:c&d=1+%", "{a,b}"]) {
  test(`reserved value ${JSON.stringify(value)} round-trips through filters`, async ({
    users,
  }) => {
    const { error } = await users.supabase
      .from("users")
      .insert({ name: value, email: "special@test.com" })
    expect(error).toBeNull()
    for (const where of [
      eq(name, value),
      or(eq(name, value), eq(id, -1)),
      inArray(name, [value]),
    ]) {
      const liveRows = await queryOnce(
        (q) => q.from({ user: users.collection }).where(() => where),
        users.supabase
      )
      const serverRows = (await executeQuery(users.supabase, {
        from: { type: "table", name: "users", alias: "user" },
        where: [where],
      })) as { name: string }[]
      expect(
        liveRows.map((row) => row.name),
        JSON.stringify(where)
      ).toEqual([value])
      expect(serverRows.map((row) => row.name)).toEqual([value])
    }
  })
}

test("LIKE treats backslashes literally on both paths", async ({ users }) => {
  const value = "a\\path"
  const { error } = await users.supabase
    .from("users")
    .insert({ name: value, email: "slash@test.com" })
  expect(error).toBeNull()
  for (const where of [
    like(name, "a\\%"),
    or(like(name, "a\\%"), eq(id, -1)),
  ]) {
    const liveRows = await queryOnce(
      (q) => q.from({ user: users.collection }).where(() => where),
      users.supabase
    )
    const serverRows = (await executeQuery(users.supabase, {
      from: { type: "table", name: "users", alias: "user" },
      where: [where],
    })) as { name: string }[]
    expect(
      liveRows.map((row) => row.name),
      JSON.stringify(where)
    ).toEqual([value])
    expect(serverRows.map((row) => row.name)).toEqual([value])
  }
})

test("unsupported OR and negated patterns retain rows for client filtering", async ({
  users,
}) => {
  const computedRows = await queryOnce(
    (q) =>
      q
        .from({ user: users.collection })
        .where(({ user }) =>
          or(eq(user.name, "Nobody"), eq(upper(user.name), "ALICE"))
        ),
    users.supabase
  )
  expect(computedRows.map((row) => row.name)).toEqual(["Alice"])
  // PostgREST would interpret * as a wildcard and remove Alice here, whereas
  // TanStack treats it literally and should keep both seeded names.
  const literalRows = await queryOnce(
    (q) =>
      q
        .from({ user: users.collection })
        .where(({ user }) => not(like(user.name, "*Ali*"))),
    users.supabase
  )
  expect(literalRows.map((row) => row.name).sort()).toEqual(["Alice", "Bob"])
})
