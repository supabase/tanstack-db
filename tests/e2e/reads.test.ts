import { createCollection, eq, liveQueryCollectionOptions } from "@tanstack/db"
import { expect, test, vi } from "vitest"
import { queryOnce } from "../../src/index"
import { makeUsersCollection, WAIT } from "./e2e.utils"

test("pushes a WHERE filter down to PostgREST", async () => {
  const { collection } = makeUsersCollection()

  // Seeded fixture: Alice is active, Bob is not — so active=true returns one row.
  const options = liveQueryCollectionOptions({
    query: (q) =>
      q
        .from({ row: collection })
        .where(({ row }) => eq(row.active, true))
        .select(({ row }) => ({ id: row.id, name: row.name })),
  })
  const live = createCollection(
    options as Extract<typeof options, { singleResult?: never }>
  )

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(1), WAIT)
  expect(live.toArray[0]?.name).toBe("Alice")

  await live.cleanup()
  await collection.cleanup()
})

test("queryOnce runs a one-shot filtered query", async () => {
  const { collection, supabase } = makeUsersCollection()

  const rows = await queryOnce(
    (q) =>
      q.from({ user: collection }).where(({ user }) => eq(user.active, true)),
    supabase
  )

  expect(rows).toHaveLength(1)
  expect(rows[0]?.name).toBe("Alice")

  await collection.cleanup()
})
