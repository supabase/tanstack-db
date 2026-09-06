import type { SupabaseClient } from "@supabase/supabase-js"
import { afterEach, describe, expect, test } from "vitest"
import { attachSupabaseListeners } from "../src/db"
import {
  createMockedUsersCollection,
  createMockFetch,
  queryResult,
} from "./test.utils"

type RealtimePayload = any

describe("attachSupabaseListeners", () => {
  let collection: ReturnType<typeof createMockedUsersCollection>

  afterEach(() => {
    collection?.cleanup()
  })

  async function setup() {
    const captured: Array<(payload: RealtimePayload) => void> = []
    const fakeSupabase = {
      channel: () => {
        const stub = {
          on: (
            _event: string,
            _filter: unknown,
            cb: (payload: RealtimePayload) => void
          ) => {
            captured.push(cb)
            return stub
          },
          subscribe: () => stub,
        }
        return stub
      },
    } as unknown as SupabaseClient

    const mockFetch = createMockFetch()
    collection = createMockedUsersCollection(mockFetch)
    // Preload from the initial PostgREST fetch, mirroring how the collection
    // is populated before any realtime event can race or replay against it.
    await queryResult((q) => q.from({ user: collection }))

    attachSupabaseListeners(fakeSupabase, "users", collection)

    const [handler] = captured
    if (!handler) {
      throw new Error("expected attachSupabaseListeners to register a callback")
    }
    return handler
  }

  test("INSERT for an already-present key with changed data does not throw", async () => {
    const handler = await setup()
    // Establish a row as already-present via a realtime INSERT, matching how
    // a real row (numeric id, schema-valid) would already be synced.
    const row = { id: 501, name: "Dana", email: "dana@test.com", active: true }
    handler({ eventType: "INSERT", new: row })
    expect(collection.get(String(row.id))?.name).toBe("Dana")

    // Realtime replayed/duplicated the same INSERT with changed data: this is
    // the exact shape of the unhandled `CollectionOperationError` from CI.
    expect(() =>
      handler({
        eventType: "INSERT",
        new: { ...row, name: "Dana Prime" },
      })
    ).not.toThrow()

    expect(collection.get(String(row.id))?.name).toBe("Dana Prime")
  })

  test("UPDATE for a key not present in the collection does not throw", async () => {
    const handler = await setup()
    const newRow = {
      id: 777,
      name: "Charlie",
      email: "charlie@test.com",
      active: true,
    }

    expect(() =>
      handler({
        eventType: "UPDATE",
        new: newRow,
      })
    ).not.toThrow()

    expect(collection.get(String(newRow.id))?.name).toBe("Charlie")
  })

  test("DELETE for a key not present does not throw", async () => {
    const handler = await setup()

    expect(() =>
      handler({
        eventType: "DELETE",
        old: { id: "user_missing" },
      })
    ).not.toThrow()

    expect(collection.has("user_missing")).toBe(false)
  })
})
