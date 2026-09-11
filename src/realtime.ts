import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimePostgresChangesFilter,
  type RealtimePostgresDeletePayload,
  type RealtimePostgresUpdatePayload,
  type SupabaseClient,
} from "@supabase/supabase-js"
import { type Collection } from "@tanstack/db"

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE"

export type RealtimeSubscription = {
  channel: ReturnType<SupabaseClient["channel"]>
  /**
   * Resolves with the terminal subscribe status — `SUBSCRIBED`,
   * `CHANNEL_ERROR`, or `CLOSED`. It is not time-bounded: while realtime-js is
   * still retrying the join (e.g. `TIMED_OUT`) it stays pending. Callers
   * distinguish a filter rejection (`CHANNEL_ERROR` on a filtered subscription)
   * from a transient connection error, so a dropped connection is not mistaken
   * for a server rejection.
   */
  outcome: Promise<REALTIME_SUBSCRIBE_STATES>
}

/**
 * Whether a row is in the collection's synced store.
 *
 * `collection.has()` reflects the optimistic view, which includes local
 * mutations that are still in flight. The manual sync writes here (and the
 * delete guard in {@link ./functions}) validate against the synced store only,
 * so that is the store to check: a Realtime echo of a pending local insert must
 * not be treated as an update, and a row with a pending local delete is still
 * there to be updated or deleted.
 */
export const isSynced = (
  collection: Collection<any, any>,
  key: string | number
): boolean => collection._state.syncedData.has(key)

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
 *
 * `filters` is the {@link ./postgrest-filters!realtimeFiltersToSearch} result:
 * one `filter` entry per active query, each a comma-joined Realtime condition
 * list. No entries means a catch-all subscription to every change on the table.
 */
export const attachSupabaseListeners = <
  T extends Record<string, any>,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  topic: string,
  tableName: string,
  collection: Collection<T, TKey>,
  filters: URLSearchParams = new URLSearchParams()
): RealtimeSubscription => {
  const channel = supabase.channel(topic)

  const changesFilter = <TEvent extends ChangeEvent>(
    event: TEvent,
    filter?: string
  ): RealtimePostgresChangesFilter<TEvent> => {
    const config: RealtimePostgresChangesFilter<TEvent> = {
      event,
      schema: "public",
      table: tableName,
    }
    if (filter) {
      config.filter = filter
    }
    return config
  }

  // The row matches an active query's filter, so it belongs in the collection
  // whether or not we have seen it before. Upsert decides insert-vs-update on
  // the synced store, which also makes replayed or racing events harmless.
  const handleUpsert = (payload: { new: T }) => {
    collection.utils.writeUpsert(payload.new)
  }

  // Unfiltered updates arrive for every row in the table, so only rows the
  // collection already holds are written — otherwise it would mirror the whole
  // table locally.
  const handleKnownUpdate = (payload: RealtimePostgresUpdatePayload<T>) => {
    const row = payload.new
    if (isSynced(collection, collection.getKeyFromItem(row))) {
      collection.utils.writeUpdate(row)
    }
  }

  const handleDelete = (payload: RealtimePostgresDeletePayload<T>) => {
    const id = collection.getKeyFromItem(payload.old as T)
    if (isSynced(collection, id)) {
      collection.utils.writeDelete(id)
    }
  }

  const conditions = filters.getAll("filter")
  // A catch-all subscription registers one unfiltered INSERT/UPDATE pair.
  for (const filter of conditions.length > 0 ? conditions : [undefined]) {
    channel.on<T>(
      "postgres_changes",
      changesFilter("INSERT", filter),
      handleUpsert
    )
    channel.on<T>(
      "postgres_changes",
      changesFilter("UPDATE", filter),
      handleUpsert
    )
  }

  // The extra unfiltered UPDATE listener only earns its keep when the INSERT/
  // UPDATE listeners above are filtered; a catch-all already sees every update.
  if (conditions.length > 0) {
    channel.on<T>(
      "postgres_changes",
      changesFilter("UPDATE"),
      handleKnownUpdate
    )
  }

  channel.on<T>("postgres_changes", changesFilter("DELETE"), handleDelete)

  let resolveOutcome: (status: REALTIME_SUBSCRIBE_STATES) => void = () =>
    undefined
  const outcome = new Promise<REALTIME_SUBSCRIBE_STATES>((resolve) => {
    resolveOutcome = resolve
  })

  channel.subscribe((status) => {
    // SUBSCRIBED means the join succeeded. CHANNEL_ERROR is how the server
    // rejects a subscription — typically a filter it cannot evaluate — but it is
    // also emitted for a transient transport failure, so the caller tells the
    // two apart. CLOSED is a terminal close before joining. TIMED_OUT is
    // deliberately not terminal: realtime-js keeps retrying the join and reports
    // the outcome through this same callback.
    if (
      status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED ||
      status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
      status === REALTIME_SUBSCRIBE_STATES.CLOSED
    ) {
      resolveOutcome(status)
    }
  })

  return { channel, outcome }
}
