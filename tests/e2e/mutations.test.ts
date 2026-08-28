import { expect, test, vi } from "vitest"
import { liveUsers, makeUsersCollection, WAIT } from "./e2e.utils"

test("updates a row through PostgREST and reflects the server row", async () => {
  const { collection, supabase } = makeUsersCollection()
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)

  const alice = live.toArray.find((user) => user.name === "Alice")
  const key = String(alice?.id)

  const tx = collection.update(key, (draft) => {
    draft.name = "Alice Updated"
  })
  await tx.isPersisted.promise

  await vi.waitFor(
    () =>
      expect(live.toArray.find((user) => user.id === alice?.id)?.name).toBe(
        "Alice Updated"
      ),
    WAIT
  )

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", alice?.id)
    .single()
  expect(error).toBeNull()
  expect(data?.name).toBe("Alice Updated")

  await live.cleanup()
  await collection.cleanup()
})

test("deletes a row through PostgREST", async () => {
  const { collection, supabase } = makeUsersCollection()
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)

  const bob = live.toArray.find((user) => user.name === "Bob")
  const tx = collection.delete(String(bob?.id))
  await tx.isPersisted.promise

  await vi.waitFor(
    () => expect(live.toArray.some((user) => user.id === bob?.id)).toBe(false),
    WAIT
  )

  const { data } = await supabase.from("users").select("*").eq("id", bob?.id)
  expect(data).toEqual([])

  await live.cleanup()
  await collection.cleanup()
})
