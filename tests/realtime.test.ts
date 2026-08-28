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
  emit,
  filtersFor,
  listenersFor,
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

function startLiveQuery(
  collection: RealtimeCollection,
  buildQuery: (collection: RealtimeCollection) => QueryFn
) {
  const opts = liveQueryCollectionOptions({ query: buildQuery(collection) })
  return track(
    createCollection(opts as Extract<typeof opts, { singleResult?: never }>)
  )
}

// Runs a live query against a fresh realtime users collection and waits for the
// realtime channel to be attached, then returns the recording mock channel.
async function captureChannel(
  buildQuery: (collection: RealtimeCollection) => QueryFn
) {
  const mockFetch = createMockFetch()
  const mockChannel = createMockChannel()
  const { collection } = createRealtimeUsersCollection(mockFetch, mockChannel)
  track(collection)

  const live = startLiveQuery(collection, buildQuery)

  await live.preload()
  await live.toArrayWhenReady()
  await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled())

  return { mockChannel, collection }
}

// The filters applied to INSERT listeners — the ones that decide which rows
// belong in the collection.
function insertFilters(mockChannel: MockChannel): Array<string | null> {
  return filtersFor(mockChannel, "INSERT")
}

describe("realtime filter propagation", () => {
  describe("supported single-comparison filters", () => {
    test("eq on a number column", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => eq(user.id, 1))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=eq.1"])
    })

    test("eq on a boolean column", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => eq(user.active, true))
      )
      expect(insertFilters(mockChannel)).toEqual(["active=eq.true"])
    })

    test("gt", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => gt(user.id, 5))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=gt.5"])
    })

    test("gte", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => gte(user.id, 5))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=gte.5"])
    })

    test("lt", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => lt(user.id, 10))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=lt.10"])
    })

    test("lte", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => lte(user.id, 10))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=lte.10"])
    })

    test("inArray maps to in.(...)", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => inArray(user.id, [1, 2, 3]))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=in.(1,2,3)"])
    })

    test("not(eq) maps to neq", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => not(eq(user.active, false)))
      )
      expect(insertFilters(mockChannel)).toEqual(["active=neq.false"])
    })

    test("isNull maps to is.null", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => isNull(user.name))
      )
      expect(insertFilters(mockChannel)).toEqual(["name=is.null"])
    })

    test("not(isNull) maps to not.is.null", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => not(isNull(user.name)))
      )
      expect(insertFilters(mockChannel)).toEqual(["name=not.is.null"])
    })

    test("not(inArray) maps to not.in", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => not(inArray(user.id, [1, 2])))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=not.in.(1,2)"])
    })

    test("not(gt) maps to not.gt", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => not(gt(user.id, 5)))
      )
      expect(insertFilters(mockChannel)).toEqual(["id=not.gt.5"])
    })

    test("composite AND becomes a comma-separated filter", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => and(eq(user.active, true), gt(user.id, 5)))
      )
      expect(insertFilters(mockChannel)).toEqual(["active=eq.true,id=gt.5"])
    })
  })

  describe("value serialization", () => {
    test("a string containing a comma is PostgREST-quoted", async () => {
      // Unquoted, the comma would read as a second ANDed condition.
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => eq(user.name, "Doe, Jane"))
      )
      expect(insertFilters(mockChannel)).toEqual(['name=eq."Doe, Jane"'])
    })

    test("a quote inside a value is escaped", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => eq(user.name, 'He said "hi", ok'))
      )
      expect(insertFilters(mockChannel)).toEqual([
        'name=eq."He said \\"hi\\", ok"',
      ])
    })

    test("a plain string is left unquoted", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => eq(user.name, "Zed"))
      )
      expect(insertFilters(mockChannel)).toEqual(["name=eq.Zed"])
    })

    test("an in list of exactly 100 values is still filtered", async () => {
      const values = Array.from({ length: 100 }, (_, index) => index)
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => inArray(user.id, values))
      )
      expect(insertFilters(mockChannel)).toEqual([
        `id=in.(${values.join(",")})`,
      ])
    })

    test("an in list longer than 100 values falls back to a catch-all", async () => {
      const values = Array.from({ length: 101 }, (_, index) => index)
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q
            .from({ user: collection })
            .where(({ user }) => inArray(user.id, values))
      )
      expect(insertFilters(mockChannel)).toEqual([null])
    })
  })

  describe("catch-all subscriptions (no filter)", () => {
    test("no WHERE clause", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) => q.from({ user: collection })
      )
      expect(insertFilters(mockChannel)).toEqual([null])
    })

    test("no redundant unfiltered UPDATE listener is added", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) => q.from({ user: collection })
      )
      expect(filtersFor(mockChannel, "UPDATE")).toEqual([null])
    })
  })

  describe("listener layout", () => {
    test("filters apply to INSERT and UPDATE, never to DELETE", async () => {
      const { mockChannel } = await captureChannel(
        (collection) => (q) =>
          q.from({ user: collection }).where(({ user }) => eq(user.id, 1))
      )

      expect(filtersFor(mockChannel, "INSERT")).toEqual(["id=eq.1"])
      // The filtered listener catches rows entering the window; the unfiltered
      // one keeps rows already held up to date after they leave it.
      expect(filtersFor(mockChannel, "UPDATE")).toEqual(["id=eq.1", null])
      // Realtime only delivers filtered deletes with `replica identity full`.
      expect(filtersFor(mockChannel, "DELETE")).toEqual([null])
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

      emit(mockChannel, { eventType: "INSERT", new: row, old: {} })

      expect(collection.has(collection.getKeyFromItem(row))).toBe(true)
    })

    test("INSERT for a row already held overwrites instead of throwing", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )

      emit(mockChannel, { eventType: "INSERT", new: row, old: {} })
      expect(() =>
        emit(mockChannel, {
          eventType: "INSERT",
          new: { ...row, name: "Twice" },
          old: {},
        })
      ).not.toThrow()

      expect(collection.get(collection.getKeyFromItem(row))?.name).toBe("Twice")
    })

    test("UPDATE writes the updated row", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )

      emit(mockChannel, { eventType: "INSERT", new: row, old: {} })
      emit(mockChannel, {
        eventType: "UPDATE",
        new: { ...row, name: "Updated" },
        old: {},
      })

      expect(collection.get(collection.getKeyFromItem(row))?.name).toBe(
        "Updated"
      )
    })

    test("a matching UPDATE for an unseen row inserts it", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c }).where(({ user }) => eq(user.id, 99))
      )
      const [filtered] = listenersFor(mockChannel, "UPDATE")

      // Realtime only delivers this to the filtered listener when the row
      // matches, which means the row has moved into the query's window.
      expect(() =>
        filtered.handler({ eventType: "UPDATE", new: row, old: {} })
      ).not.toThrow()

      expect(collection.has(collection.getKeyFromItem(row))).toBe(true)
    })

    test("an unfiltered UPDATE for an unseen row is ignored", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c }).where(({ user }) => eq(user.id, 1))
      )
      const catchAll = listenersFor(mockChannel, "UPDATE").find(
        (call) => !call.config.filter
      )

      // Would otherwise mirror every row in the table into the collection.
      expect(() =>
        catchAll?.handler({ eventType: "UPDATE", new: row, old: {} })
      ).not.toThrow()

      expect(collection.has(collection.getKeyFromItem(row))).toBe(false)
    })

    test("DELETE removes the row, and is a no-op for an unknown key", async () => {
      const { mockChannel, collection } = await captureChannel(
        (c) => (q) => q.from({ user: c })
      )

      emit(mockChannel, { eventType: "INSERT", new: row, old: {} })
      const key = collection.getKeyFromItem(row)
      expect(collection.has(key)).toBe(true)

      emit(mockChannel, { eventType: "DELETE", new: {}, old: row })
      expect(collection.has(key)).toBe(false)

      // A delete for a key the collection never had must not throw.
      expect(() =>
        emit(mockChannel, {
          eventType: "DELETE",
          new: {},
          old: { id: 12_345, name: "", email: "", active: false },
        })
      ).not.toThrow()
    })
  })

  describe("subscribing before fetching", () => {
    test("the first fetch waits for the channel to be subscribed", async () => {
      const mockFetch = createMockFetch()
      const mockChannel = createMockChannel({ autoSubscribe: false })
      const { collection } = createRealtimeUsersCollection(
        mockFetch,
        mockChannel
      )
      track(collection)

      const live = startLiveQuery(
        collection,
        (c) => (q) => q.from({ user: c }).where(({ user }) => eq(user.id, 1))
      )
      const preloaded = live.preload()

      await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled())
      // A row written now would be missed by the fetch, so it must not have
      // started before the subscription is live.
      expect(mockFetch).not.toHaveBeenCalled()

      mockChannel.confirmSubscribed()
      await preloaded
      await live.toArrayWhenReady()

      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe("resubscribing when the filter set changes", () => {
    test("uses a fresh channel topic and drops the previous channel", async () => {
      const mockFetch = createMockFetch()
      const channels: Array<MockChannel> = []
      const { collection, supabase } = createRealtimeUsersCollection(
        mockFetch,
        () => {
          const channel = createMockChannel()
          channels.push(channel)
          return channel
        }
      )
      track(collection)

      const first = startLiveQuery(
        collection,
        (c) => (q) => q.from({ user: c }).where(({ user }) => eq(user.id, 1))
      )
      await first.preload()
      await first.toArrayWhenReady()
      await vi.waitFor(() => expect(channels.length).toBe(1))

      const second = startLiveQuery(
        collection,
        (c) => (q) => q.from({ user: c }).where(({ user }) => gt(user.id, 5))
      )
      await second.preload()
      await second.toArrayWhenReady()
      await vi.waitFor(() => expect(channels.length).toBe(2))

      const topics = (
        supabase.channel as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.map(([topic]) => topic)
      // A repeated topic would hand back the channel being torn down.
      expect(new Set(topics).size).toBe(topics.length)

      // The union of both queries' filters is now subscribed.
      expect(insertFilters(channels[1])).toEqual(["id=eq.1", "id=gt.5"])

      // The old channel is only dropped once the replacement is subscribed.
      await vi.waitFor(() =>
        expect(supabase.removeChannel).toHaveBeenCalledWith(channels[0])
      )
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
