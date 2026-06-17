import {
  and,
  type Collection,
  createCollection,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  liveQueryCollectionOptions,
  lt,
  lte,
  not,
} from "@tanstack/db"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { buildRealtimeFilters } from "../src/realtime"
import {
  createMockChannel,
  createMockFetch,
  createRealtimeUsersCollection,
  type MockChannel,
} from "./test.utils"

// Collections created during a test, torn down afterwards so their query
// observers are removed (and the realtime channel detached).
let createdCollections: Array<Collection<any, any>> = []

function track<T extends Collection<any, any>>(collection: T): T {
  createdCollections.push(collection)
  return collection
}

beforeEach(() => {
  createdCollections = []
})

afterEach(() => {
  // Tear down in reverse creation order so dependent live queries are cleaned
  // up before the source collections they depend on.
  for (const collection of [...createdCollections].reverse()) {
    collection.cleanup()
  }
})

type QueryFn = Parameters<typeof liveQueryCollectionOptions>[0]["query"]
type RealtimeCollection = ReturnType<
  typeof createRealtimeUsersCollection
>["collection"]

// Runs a live query against a fresh realtime users collection and waits for the
// realtime channel to be attached, then returns the recording mock channel.
async function captureChannel(
  buildQuery: (collection: RealtimeCollection) => QueryFn
) {
  const mockFetch = createMockFetch()
  const mockChannel = createMockChannel()
  const { collection } = createRealtimeUsersCollection(mockFetch, mockChannel)
  track(collection)

  const opts = liveQueryCollectionOptions({ query: buildQuery(collection) })
  const live = track(
    createCollection(opts as Extract<typeof opts, { singleResult?: never }>)
  )

  await live.preload()
  await live.toArrayWhenReady()
  await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled())

  return { mockChannel, collection }
}

// Maps the recorded postgres_changes listeners to their filter strings (null
// when the listener is a catch-all with no `filter`).
function realtimeFilters(mockChannel: MockChannel): Array<string | null> {
  return mockChannel.onCalls.map((call) => call.config.filter ?? null)
}

describe("realtime filter propagation", () => {
  describe("supported single-comparison filters", () => {
    test("eq on a number column", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => eq(user.id, 1))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=eq.1"])
    })

    test("eq on a boolean column", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => eq(user.active, true))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["active=eq.true"])
    })

    test("gt", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => gt(user.id, 5))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=gt.5"])
    })

    test("gte", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => gte(user.id, 5))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=gte.5"])
    })

    test("lt", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => lt(user.id, 10))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=lt.10"])
    })

    test("lte", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => lte(user.id, 10))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=lte.10"])
    })

    test("inArray maps to in.(...)", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => inArray(user.id, [1, 2, 3]))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["id=in.(1,2,3)"])
    })

    test("not(eq) maps to neq", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => not(eq(user.active, false)))
      )
      expect(realtimeFilters(mockChannel)).toEqual(["active=neq.false"])
    })
  })

  describe("catch-all subscriptions (no filter)", () => {
    test("no WHERE clause", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) => q.from({ user: collection })
      )
      expect(realtimeFilters(mockChannel)).toEqual([null])
    })

    test("isNull has no Realtime operator", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => isNull(user.name))
      )
      expect(realtimeFilters(mockChannel)).toEqual([null])
    })

    test("composite AND cannot be a single Realtime filter", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => and(eq(user.active, true), gt(user.id, 5)))
      )
      expect(realtimeFilters(mockChannel)).toEqual([null])
    })
  })

  describe("payload routing into the collection", () => {
    const row = {
      id: 99,
      name: "Zed",
      email: "zed@test.com",
      active: true,
    }

    test("INSERT writes the new row", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )
      const { handler } = mockChannel.onCalls[0]

      handler({ eventType: "INSERT", new: row, old: {} })

      const key = collection.getKeyFromItem(row)
      expect(collection.has(key)).toBe(true)
    })

    test("UPDATE writes the updated row", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )
      const { handler } = mockChannel.onCalls[0]

      handler({ eventType: "INSERT", new: row, old: {} })
      handler({
        eventType: "UPDATE",
        new: { ...row, name: "Updated" },
        old: {},
      })

      const key = collection.getKeyFromItem(row)
      expect(collection.get(key)?.name).toBe("Updated")
    })

    test("DELETE removes the row, and is a no-op for an unknown key", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )
      const { handler } = mockChannel.onCalls[0]

      handler({ eventType: "INSERT", new: row, old: {} })
      const key = collection.getKeyFromItem(row)
      expect(collection.has(key)).toBe(true)

      handler({ eventType: "DELETE", new: {}, old: row })
      expect(collection.has(key)).toBe(false)

      // A delete for a key the collection never had must not throw.
      expect(() =>
        handler({
          eventType: "DELETE",
          new: {},
          old: { id: 12_345, name: "", email: "", active: false },
        })
      ).not.toThrow()
    })
  })

  // `or(...)` (and other unsupported expressions) cannot be driven through the
  // live-query path because the query's own supabaseQueryFn calls the same
  // throwing extractSimpleComparisons. Cover the defensive fallback directly.
  describe("buildRealtimeFilters falls back instead of throwing", () => {
    test("an unsupported expression yields a catch-all", () => {
      const orExpression = { type: "func", name: "or", args: [] } as any
      expect(buildRealtimeFilters([orExpression])).toEqual([null])
    })
  })
})
