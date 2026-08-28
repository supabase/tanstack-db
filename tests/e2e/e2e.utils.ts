/** biome-ignore-all lint/correctness/noEmptyPattern: vitest fixtures without dependencies must destructure an empty context object */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createCollection, createLiveQueryCollection } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { test as baseTest, expect, inject, vi } from "vitest"
import { supabaseCollectionOptions } from "../../src/index"
import { usersSchema } from "../test.utils"

// Shared polling window for awaiting async PostgREST/realtime propagation.
export const WAIT = { timeout: 15_000, interval: 200 } as const

// A fresh Supabase client using the anon key, exactly like a browser would.
const makeSupabase = (): SupabaseClient =>
  createClient(inject("supabaseUrl"), inject("supabaseAnonKey"))

// Each collection gets its own QueryClient: the realtime channel registry in
// src/db.ts is keyed by QueryClient, so a fresh one per collection prevents
// channels leaking across tests.
const makeUsersCollection = ({ realtime = false } = {}) => {
  const supabase = makeSupabase()
  const collection = createCollection(
    supabaseCollectionOptions({
      tableName: "users",
      keys: ["id"],
      schema: usersSchema,
      supabase,
      queryClient: new QueryClient(),
      realtime,
    })
  )
  return { collection, supabase }
}

type UsersContext = ReturnType<typeof makeUsersCollection>
type UsersCollection = UsersContext["collection"]

// An on-demand collection only loads when a live query drives demand. This live
// query also creates the active query that the realtime channel attaches to.
const liveUsers = (base: UsersCollection) =>
  createLiveQueryCollection((q) =>
    q.from({ row: base }).select(({ row }) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      active: row.active,
    }))
  )

type LiveUsersCollection = ReturnType<typeof liveUsers>

// Waits until the adapter's realtime channel for the table is actually joined,
// so changes written afterwards are guaranteed to be captured. Coupled to the
// adapter naming its channel after the table (supabase.channel(tableName) in
// src/db.ts), which supabase-js exposes under the "realtime:" topic prefix.
const waitForChannel = (supabase: SupabaseClient, table: string) =>
  vi.waitFor(() => {
    const channel = supabase
      .getChannels()
      .find((c) => c.topic === `realtime:${table}`)
    expect(channel?.state).toBe("joined")
  }, WAIT)

const preloadSeeded = async (live: LiveUsersCollection) => {
  await live.preload()
  // The reset_e2e() seed always yields exactly Alice and Bob.
  await vi.waitFor(() => expect(live.size).toBe(2), WAIT)
}

// Fixtures are lazy: a test only pays for what it destructures. Teardown runs
// in reverse initialization order and ALWAYS runs, even when the test fails —
// unlike trailing cleanup calls in a test body.
export const test = baseTest.extend<{
  /** Base users collection + its anon client. */
  users: UsersContext
  /** Preloaded live query over `users`, seeded rows awaited. */
  usersLive: LiveUsersCollection
  /** Like `users` but with realtime enabled. */
  rtUsers: UsersContext
  /** Preloaded live query over `rtUsers`, realtime channel joined. */
  rtUsersLive: LiveUsersCollection
  /** A second anon client acting as "another user" for realtime writes. */
  other: SupabaseClient
}>({
  users: async ({}, use) => {
    const ctx = makeUsersCollection()
    await use(ctx)
    await ctx.collection.cleanup()
    await ctx.supabase.removeAllChannels()
  },
  usersLive: async ({ users }, use) => {
    const live = liveUsers(users.collection)
    await preloadSeeded(live)
    await use(live)
    await live.cleanup()
  },
  rtUsers: async ({}, use) => {
    const ctx = makeUsersCollection({ realtime: true })
    await use(ctx)
    await ctx.collection.cleanup()
    await ctx.supabase.removeAllChannels()
  },
  rtUsersLive: async ({ rtUsers }, use) => {
    const live = liveUsers(rtUsers.collection)
    await preloadSeeded(live)
    // Wait until the realtime channel is joined before the test writes,
    // otherwise a change could be published before the subscription exists.
    await waitForChannel(rtUsers.supabase, "users")
    await use(live)
    await live.cleanup()
  },
  other: async ({}, use) => {
    const client = makeSupabase()
    await use(client)
    await client.removeAllChannels()
  },
})
