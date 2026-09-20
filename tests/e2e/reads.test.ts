import { createLiveQueryCollection, eq } from "@tanstack/db"
import { expect, vi } from "vitest"
import { queryOnce } from "../../src/index"
import { test, WAIT } from "./e2e.utils"

test("reads seeded rows through PostgREST", ({ usersLive }) => {
  const names = usersLive.toArray.map((user) => user.name).sort()
  expect(names).toEqual(["Alice", "Bob"])
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

test("reads a set larger than the server row cap across pages", async ({
  users,
  other,
}) => {
  // config.toml caps responses at 2 rows; reset_e2e seeds Alice + Bob, so three
  // more rows push the matching set past the cap and force the paging loop.
  const { error } = await other.from("users").insert([
    { name: "Carol", email: "carol@test.com", active: true },
    { name: "Dave", email: "dave@test.com", active: true },
    { name: "Erin", email: "erin@test.com", active: true },
  ] as unknown as never)
  expect(error).toBeNull()

  const live = createLiveQueryCollection((q) =>
    q
      .from({ row: users.collection })
      .select(({ row }) => ({ id: row.id, name: row.name }))
  )

  try {
    await live.preload()
    await vi.waitFor(() => expect(live.size).toBe(5), WAIT)
    // The full set comes back despite the cap, with each row exactly once.
    expect(live.toArray.map((row) => row.name).sort()).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Dave",
      "Erin",
    ])
    expect(new Set(live.toArray.map((row) => row.id)).size).toBe(5)
  } finally {
    await live.cleanup()
  }
})
