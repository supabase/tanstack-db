import { createLiveQueryCollection, eq } from "@tanstack/db"
import { expect, vi } from "vitest"
import {
  makeFilteredRealtimeUsers,
  test,
  WAIT,
  waitForChannel,
} from "./e2e.utils"

// These tests drive the realtimeUseFilter path end to end: a live query's WHERE
// becomes a server-side postgres_changes filter via realtimeFiltersToSearch,
// which now serializes scalar values with the shared PostgREST `quoteValue`.
// Values containing reserved characters (or surrounding whitespace) must be
// quoted so they cannot split the comma-ANDed filter — an unquoted comma would
// make the real Realtime server reject the subscription (CHANNEL_ERROR) or
// match the wrong rows. Each case subscribes with such a value and asserts the
// matching insert is actually delivered through the live socket.

// Names deliberately exercise quoteValue's branches: a comma (reserved) and
// surrounding whitespace (only quoted since the switch to quoteValue).
const NAMES = ["Doe, Jane", " spaced "] as const

for (const value of NAMES) {
  test(`realtime filter on ${JSON.stringify(value)} delivers matching inserts`, async ({
    other,
  }) => {
    const { collection, supabase } = makeFilteredRealtimeUsers()
    const live = createLiveQueryCollection((q) =>
      q
        .from({ row: collection })
        .where(({ row }) => eq(row.name, value))
        .select(({ row }) => ({ id: row.id, name: row.name }))
    )

    try {
      await live.preload()
      // The seed has no row with this name, so the filtered query starts empty.
      await vi.waitFor(() => expect(live.size).toBe(0), WAIT)
      // The channel only reaches `joined` if the server accepted the quoted
      // filter, so this alone proves quoteValue produced valid filter syntax.
      await waitForChannel(supabase, "users")

      const match = { id: 300, name: value, email: "match@test.com" }
      const miss = { id: 301, name: "Someone Else", email: "miss@test.com" }
      const { error } = await other
        .from("users")
        .insert([match, miss] as unknown as never)
      expect(error).toBeNull()

      // The matching row arrives through the filtered subscription.
      await vi.waitFor(
        () => expect(live.toArray.map((row) => row.name)).toEqual([value]),
        WAIT
      )
      // The non-matching row was filtered out server-side and never synced.
      expect(collection.has(miss.id)).toBe(false)
    } finally {
      await live.cleanup()
      await collection.cleanup()
      await supabase.removeAllChannels()
    }
  })
}
