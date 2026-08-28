import { createCollection, liveQueryCollectionOptions } from "@tanstack/db"
import { expect, test, vi } from "vitest"
import { makeSupabase, makeUsersCollection } from "./e2e.utils"

const WAIT = { timeout: 15_000, interval: 200 } as const

type UsersCollection = ReturnType<typeof makeUsersCollection>["collection"]

// An on-demand collection only loads when a live query drives demand. This live
// query also creates the active query that the realtime channel attaches to.
const liveUsers = (base: UsersCollection) => {
  const options = liveQueryCollectionOptions({
    query: (q) =>
      q.from({ row: base }).select(({ row }) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        active: row.active,
      })),
  })
  return createCollection(
    options as Extract<typeof options, { singleResult?: never }>
  )
}

test("reads seeded rows through PostgREST", async () => {
  const { collection } = makeUsersCollection()
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)

  const names = live.toArray.map((user) => user.name).sort()
  expect(names).toEqual(["Alice", "Bob"])

  await live.cleanup()
  await collection.cleanup()
})

test("inserts a row through PostgREST and reflects the server row", async () => {
  const { collection, supabase } = makeUsersCollection()
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)

  // The adapter POSTs the row, then writes the server's returned row back into
  // the collection; the live query reflects it.
  const tx = collection.insert({
    id: 100,
    name: "Carol",
    email: "carol@test.com",
    active: true,
  })
  await tx.isPersisted.promise

  await vi.waitFor(
    () => expect(live.toArray.some((user) => user.name === "Carol")).toBe(true),
    WAIT
  )
  const carol = live.toArray.find((user) => user.name === "Carol")
  expect(carol?.id).toBe(100)

  // The row really exists in the database.
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", "carol@test.com")
    .single()
  expect(error).toBeNull()
  expect(data?.name).toBe("Carol")

  await live.cleanup()
  await collection.cleanup()
})

test("receives realtime inserts made by another client", async () => {
  const { collection, supabase } = makeUsersCollection({ realtime: true })
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)

  // Wait until the realtime channel is actually joined before writing, otherwise
  // the change could be published before the subscription is established.
  await vi.waitFor(() => {
    const channel = supabase
      .getChannels()
      .find((c) => c.topic === "realtime:users")
    expect(channel?.state).toBe("joined")
  }, WAIT)

  // A second client acts as "another user" so the change arrives over realtime.
  const other = makeSupabase()
  const draft = { id: 200, name: "Zoe", email: "zoe@test.com", active: true }
  const { error } = await other.from("users").insert(draft as unknown as never)
  expect(error).toBeNull()

  await vi.waitFor(
    () => expect(live.toArray.some((user) => user.name === "Zoe")).toBe(true),
    WAIT
  )

  await live.cleanup()
  await collection.cleanup()
  await supabase.removeAllChannels()
  await other.removeAllChannels()
})
