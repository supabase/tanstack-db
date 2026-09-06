import { expect, vi } from "vitest"
import { test, WAIT } from "./e2e.utils"

test("inserts a row through PostgREST and reflects the server row", async ({
  users,
  usersLive,
}) => {
  const tx = users.collection.insert({
    id: 100,
    name: "Carol",
    email: "carol@test.com",
    active: true,
  })
  await tx.isPersisted.promise

  await vi.waitFor(
    () =>
      expect(usersLive.toArray.some((user) => user.name === "Carol")).toBe(
        true
      ),
    WAIT
  )
  expect(usersLive.toArray.find((user) => user.name === "Carol")?.id).toBe(100)

  // The row really exists in the database.
  const { data, error } = await users.supabase
    .from("users")
    .select("*")
    .eq("email", "carol@test.com")
    .single()
  expect(error).toBeNull()
  expect(data?.name).toBe("Carol")
})

test("updates a row through PostgREST and reflects the server row", async ({
  users,
  usersLive,
}) => {
  const alice = usersLive.toArray.find((user) => user.name === "Alice")

  const tx = users.collection.update(String(alice?.id), (draft) => {
    draft.name = "Alice Updated"
  })
  await tx.isPersisted.promise

  await vi.waitFor(
    () =>
      expect(
        usersLive.toArray.find((user) => user.id === alice?.id)?.name
      ).toBe("Alice Updated"),
    WAIT
  )

  const { data, error } = await users.supabase
    .from("users")
    .select("*")
    .eq("id", alice?.id)
    .single()
  expect(error).toBeNull()
  expect(data?.name).toBe("Alice Updated")
})

test("deletes a row through PostgREST", async ({ users, usersLive }) => {
  const bob = usersLive.toArray.find((user) => user.name === "Bob")

  const tx = users.collection.delete(String(bob?.id))
  await tx.isPersisted.promise

  await vi.waitFor(
    () =>
      expect(usersLive.toArray.some((user) => user.id === bob?.id)).toBe(false),
    WAIT
  )

  const { data } = await users.supabase
    .from("users")
    .select("*")
    .eq("id", bob?.id)
  expect(data).toEqual([])
})
