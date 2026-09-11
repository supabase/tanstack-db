import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesFilter,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
} from "@supabase/supabase-js"
import { type Collection } from "@tanstack/db"

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE"

export type RealtimeSubscription = {
  channel: ReturnType<SupabaseClient["channel"]>
  /**
   * Resolves once the channel reported any subscription status, or after
   * {@link SUBSCRIBE_TIMEOUT_MS} if the server never answers. Never rejects, so
   * callers can safely gate work on it without an unreachable Realtime server
   * blocking them forever.
   */
  ready: Promise<void>
  /**
   * Resolves with the terminal subscribe status — `SUBSCRIBED`,
   * `CHANNEL_ERROR`, or `CLOSED`. Unlike {@link ready} it is not time-bounded:
   * while realtime-js is still retrying the join (e.g. `TIMED_OUT`) it stays
   * pending. Callers distinguish a filter rejection (`CHANNEL_ERROR` on a
   * filtered subscription) from a transient connection error, so a dropped
   * connection is not mistaken for a server rejection.
   */
  outcome: Promise<REALTIME_SUBSCRIBE_STATES>
}

/** Never let a fetch wait longer than this for the channel to subscribe. */
const SUBSCRIBE_TIMEOUT_MS = 2000

/** Convert decoded parameter pairs to Realtime's comma-ANDed wire form. */
const realtimeFilterToString = (params: URLSearchParams): string | null => {
  const conditions = Array.from(params).map(
    ([column, value]) => `${column}=${value}`
  )
  return conditions.length > 0 ? conditions.join(",") : null
}

/**
 * Subscribes to Supabase Realtime changes for a table and writes inserts,
 * updates, and deletes into the collection.
 *
 * Filters are applied to INSERT and UPDATE listeners only: a filtered event is
 * Realtime telling us the row matches an active query, which is what makes it
 * belong in the collection — including a row that an UPDATE moved into that
 * query's window. Two extra unfiltered listeners cover what a filtered
 * subscription cannot see:
 *
 * - UPDATE, so a row already in the collection still receives its changes after
 *   it stops matching the filter instead of going stale.
 * - DELETE, because Realtime only delivers filtered delete events for tables
 *   with `replica identity full`, and delete payloads are just the key anyway.
 */
export const attachSupabaseListeners = <
  T extends Record<string, any>,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  topic: string,
  tableName: string,
  collection: Collection<T, TKey>,
  filters: URLSearchParams[] = [new URLSearchParams()]
): RealtimeSubscription | null => {
  if (!supabase.channel) {
    return null
  }

  const channel = supabase.channel(topic)
  const catchAllFilter = new URLSearchParams()

  const changesFilter = <TEvent extends ChangeEvent>(
    event: TEvent,
    filter: URLSearchParams
  ): RealtimePostgresChangesFilter<TEvent> => {
    const config: RealtimePostgresChangesFilter<TEvent> = {
      event,
      schema: "public",
      table: tableName,
    }
    const serializedFilter = realtimeFilterToString(filter)
    if (serializedFilter) {
      config.filter = serializedFilter
    }
    return config
  }

  // `collection.has()` reflects the optimistic view, which includes local
  // mutations that are still in flight. The manual sync writes below validate
  // against the synced store only, so that is the store to check: a Realtime
  // echo of a pending local insert must not be treated as an update, and a
  // row with a pending local delete is still there to be updated or deleted.
  const isSynced = (id: TKey) => collection._state.syncedData.has(id)

  // The row matches an active query's filter, so it belongs in the collection
  // whether or not we have seen it before. Upsert decides insert-vs-update on
  // the synced store, which also makes replayed or racing events harmless.
  const handleUpsert = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "INSERT" && payload.eventType !== "UPDATE") {
      return
    }
    collection.utils.writeUpsert(payload.new as T)
  }

  // Unfiltered updates arrive for every row in the table, so only rows the
  // collection already holds are written — otherwise it would mirror the whole
  // table locally.
  const handleKnownUpdate = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "UPDATE") {
      return
    }
    const row = payload.new as T
    if (isSynced(collection.getKeyFromItem(row))) {
      collection.utils.writeUpdate(row)
    }
  }

  const handleDelete = (payload: RealtimePostgresChangesPayload<T>) => {
    if (payload.eventType !== "DELETE") {
      return
    }
    const id = collection.getKeyFromItem(payload.old as T)
    if (isSynced(id)) {
      collection.utils.writeDelete(id)
    }
  }

  for (const filter of filters) {
    channel.on<T>("postgres_changes", changesFilter("INSERT", filter), (p) =>
      handleUpsert(p as RealtimePostgresChangesPayload<T>)
    )
    channel.on<T>("postgres_changes", changesFilter("UPDATE", filter), (p) =>
      handleUpsert(p as RealtimePostgresChangesPayload<T>)
    )
  }

  if (filters.some((filter) => filter.size > 0)) {
    channel.on<T>(
      "postgres_changes",
      changesFilter("UPDATE", catchAllFilter),
      (p) => handleKnownUpdate(p as RealtimePostgresChangesPayload<T>)
    )
  }

  channel.on<T>(
    "postgres_changes",
    changesFilter("DELETE", catchAllFilter),
    (p) => handleDelete(p as RealtimePostgresChangesPayload<T>)
  )

  let resolveOutcome: (status: REALTIME_SUBSCRIBE_STATES) => void = () =>
    undefined
  const outcome = new Promise<REALTIME_SUBSCRIBE_STATES>((resolve) => {
    resolveOutcome = resolve
  })

  const ready = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, SUBSCRIBE_TIMEOUT_MS)
    channel.subscribe((status) => {
      clearTimeout(timeout)
      resolve()
      // SUBSCRIBED means the join succeeded. CHANNEL_ERROR is how the server
      // rejects a subscription — typically a filter it cannot evaluate — but it
      // is also emitted for a transient transport failure, so the caller tells
      // the two apart. CLOSED is a terminal close before joining. TIMED_OUT is
      // deliberately not terminal: realtime-js keeps retrying the join and
      // reports the outcome through this same callback.
      if (
        status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED ||
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.CLOSED
      ) {
        resolveOutcome(status)
      }
    })
  })

  return { channel, ready, outcome }
}
