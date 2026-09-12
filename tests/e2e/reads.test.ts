import { createLiveQueryCollection, eq, IR } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { expect, vi } from "vitest"
import { supabaseQueryFn } from "../../src/functions"
import { queryOnce } from "../../src/index"
import { test, WAIT } from "./e2e.utils"

test("reads seeded rows through PostgREST", ({ usersLive }) => {
  const names = usersLive.toArray.map((user) => user.name).sort()
  expect(names).toEqual(["Alice", "Bob"])
})

test("reads more rows than the PostgREST response limit", async ({
  other,
  users,
}) => {
  const additionalUsers = Array.from({ length: 1001 }, (_, index) => ({
    active: true,
    email: `pagination-${index}@test.com`,
    name: `Pagination User ${index}`,
  }))
  const { error } = await other.from("users").insert(additionalUsers)
  expect(error).toBeNull()

  const live = createLiveQueryCollection((q) =>
    q.from({ row: users.collection }).select(({ row }) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      active: row.active,
    }))
  )

  try {
    await live.preload()
    await vi.waitFor(() => expect(live.size).toBe(1003), WAIT)
  } finally {
    await live.cleanup()
  }
})

test("pushes a WHERE filter down to PostgREST", async ({ users }) => {
  // Seeded fixture: Alice is active, Bob is not — so active=true returns one row.
  const live = createLiveQueryCollection((q) =>
    q
      .from({ row: users.collection })
      .where(({ row }) => eq(row.active, true))
      .select(({ row }) => ({ id: row.id, name: row.name }))
  )

  // finally (not fixture teardown) so this live query is cleaned up before the
  // `users` fixture tears down the base collection it depends on.
  try {
    await live.preload()
    await vi.waitFor(() => expect(live.size).toBe(1), WAIT)
    expect(live.toArray[0]?.name).toBe("Alice")
  } finally {
    await live.cleanup()
  }
})

test("pagination retrieves each row once when the requested sort has ties", async ({
  other,
}) => {
  const { error } = await other.from("users").insert(
    Array.from({ length: 20 }, (_, index) => ({
      active: true,
      email: `tied-pagination-${index}@test.com`,
      name: "Same name",
    }))
  )
  expect(error).toBeNull()

  const { data: expected, error: readError } = await other
    .from("users")
    .select("*")
    .order("active", { ascending: false })
    .order("id")
  expect(readError).toBeNull()

  const queryClient = new QueryClient()
  try {
    const rows = await supabaseQueryFn(
      other,
      "users",
      ["id"],
      {
        client: queryClient,
        queryKey: ["users"],
        signal: new AbortController().signal,
        meta: {
          loadSubsetOptions: {
            orderBy: [
              {
                expression: new IR.PropRef(["active"]),
                compareOptions: { direction: "desc", nulls: "last" },
              },
            ],
          },
        },
      },
      2
    )

    expect(rows).toHaveLength(22)
    expect(rows).toEqual(expected)
  } finally {
    queryClient.clear()
  }
})

test("queryOnce runs a one-shot filtered query", async ({ users }) => {
  const rows = await queryOnce(
    (q) =>
      q
        .from({ user: users.collection })
        .where(({ user }) => eq(user.active, true)),
    users.supabase
  )

  expect(rows).toHaveLength(1)
  expect(rows[0]?.name).toBe("Alice")
})
