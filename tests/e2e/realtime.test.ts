import type { SupabaseClient } from "@supabase/supabase-js"
import { expect, test, vi } from "vitest"
import { liveUsers, makeSupabase, makeUsersCollection, WAIT } from "./e2e.utils"

// Waits until the adapter's realtime channel for `users` is actually joined, so
// changes written afterwards are guaranteed to be captured.
const waitForUsersChannel = (supabase: SupabaseClient) =>
  vi.waitFor(() => {
    const channel = supabase
      .getChannels()
      .find((c) => c.topic === "realtime:users")
    expect(channel?.state).toBe("joined")
  }, WAIT)

test("receives realtime updates made by another client", async () => {
  const { collection, supabase } = makeUsersCollection({ realtime: true })
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)
  await waitForUsersChannel(supabase)

  const alice = live.toArray.find((user) => user.name === "Alice")
  const other = makeSupabase()
  const { error } = await other
    .from("users")
    .update({ name: "Alice Realtime" })
    .eq("id", alice?.id)
  expect(error).toBeNull()

  await vi.waitFor(
    () =>
      expect(live.toArray.find((user) => user.id === alice?.id)?.name).toBe(
        "Alice Realtime"
      ),
    WAIT
  )

  await live.cleanup()
  await collection.cleanup()
  await supabase.removeAllChannels()
  await other.removeAllChannels()
})

// Exercises the delete path, where the adapter derives the collection key from
// the realtime payload's `old`. That works here because the collection key is
// the primary key, which the default replica identity always includes.
test("receives realtime deletes made by another client", async () => {
  const { collection, supabase } = makeUsersCollection({ realtime: true })
  const live = liveUsers(collection)

  await live.preload()
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)
  await waitForUsersChannel(supabase)

  const bob = live.toArray.find((user) => user.name === "Bob")
  const other = makeSupabase()
  const { error } = await other.from("users").delete().eq("id", bob?.id)
  expect(error).toBeNull()

  await vi.waitFor(
    () => expect(live.toArray.some((user) => user.id === bob?.id)).toBe(false),
    WAIT
  )

  await live.cleanup()
  await collection.cleanup()
  await supabase.removeAllChannels()
  await other.removeAllChannels()
})
