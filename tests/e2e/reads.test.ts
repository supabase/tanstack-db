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
