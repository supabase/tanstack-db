# Query DB Collection dependency evaluation

## Decision

Keep `@tanstack/query-db-collection` as the adapter's query-backed sync layer.
Do not replace it with a direct TanStack DB collection implementation now.

The dependency owns substantial, generic query-to-collection lifecycle logic
that the Supabase adapter would otherwise have to copy and maintain. The
Supabase-specific requirements that have needed custom behavior so far,
including PostgREST query translation, pagination, mutation persistence, and
Realtime reconciliation, already fit around that layer without changing the
public collection API.

The next step should be to make the existing boundary narrower and cover it
with contract tests. Replacement should be reconsidered only when there is a
concrete requirement that cannot be implemented safely through the current
`queryCollectionOptions` integration.

This evaluation describes `main` at `593f3bd`, with
`@tanstack/db@0.9.2`, `@tanstack/query-db-collection@1.2.15`, and
`@tanstack/query-core@5.101.0`.

## Current responsibilities

The read path in [`src/db.ts`](../src/db.ts) and
[`src/functions.ts`](../src/functions.ts) has three distinct owners:

1. TanStack DB turns a live query into `LoadSubsetOptions` and asks the source
   collection to load that subset.
2. Query DB Collection turns that request into a TanStack Query observer,
   calls the adapter's `queryFn`, and reconciles the returned rows into the
   collection's synced store.
3. The Supabase adapter translates the subset to PostgREST parameters and
   performs the request.

The mutation and Realtime paths deliberately bypass part of the default Query
DB Collection behavior:

- TanStack DB core owns the optimistic mutation state and rollback when a
  persistence callback rejects.
- The Supabase `onInsert`, `onUpdate`, and `onDelete` callbacks persist through
  PostgREST, write the authoritative server result to the synced store, and
  return `{ refetch: false }`.
- Supabase Realtime listeners in [`src/realtime.ts`](../src/realtime.ts) write
  remote changes directly to the synced store. Their lifecycle is derived from
  active TanStack Query observers so subscriptions can follow the active query
  filters.

In other words, Query DB Collection is the generic read/cache bridge. It does
not own Supabase request semantics, Realtime, or optimistic rollback.

### What Query DB Collection provides today

| Responsibility | Why the adapter uses it |
| --- | --- |
| On-demand subset loading | Converts `LoadSubsetOptions` into one query per filter, order, limit, and pagination window. |
| Request lifecycle | Uses `QueryObserver` for caching, request deduplication, retries, stale data, reconnects, and refetches. It supplies an abort signal, although the adapter does not currently forward that signal to PostgREST. |
| Query metadata | Places `loadSubsetOptions` in query metadata, which the Supabase query and Realtime layers read. |
| Row ownership | Tracks which query keys own each row so overlapping subsets can coexist and unloading one subset does not remove rows still owned by another. |
| Result reconciliation | Diffs successful query results and writes inserts, updates, and deletes as one collection sync transaction. |
| Observer cleanup | Reference-counts shared observers and releases rows and cached queries when subsets become unused or are garbage-collected. |
| Collection status | Marks the collection ready or errored based on initial and later query outcomes. |
| Persistence hooks | Supports persisted row ownership and retention through TanStack DB metadata, even though this adapter does not configure that capability today. |
| Mutation integration | Wraps persistence callbacks with optional refetch behavior and exposes direct synced-store write helpers. |

Reimplementing the first seven rows would be required before a direct adapter
could preserve current behavior.

### What the Supabase adapter provides

- Translation from TanStack DB expressions to PostgREST query parameters.
- Stable query keys that match the request and keep pagination windows
  independent.
- Multi-page fetching, including keyset cursor boundaries and tied values.
- PostgREST insert, update, and delete persistence.
- Reconciliation of server-returned rows without a redundant refetch.
- Supabase Realtime subscription setup, filter fallback, channel replacement,
  and direct synced-store writes.
- A shared default `QueryClient`, while allowing callers to provide their own.

The one-shot [`queryOnce`](../src/query-once.ts) path already runs directly on
TanStack DB and Supabase. It does not depend on Query DB Collection, so this
decision concerns collection synchronization rather than every read API.

## Supabase-specific fit and constraints

### Where the dependency helps

- PostgREST pushdown only needs to implement `queryFn`; it does not need its own
  observer, retry, cache, or subset cleanup machinery.
- Pagination can create separate query keys for separate windows while relying
  on the dependency's row ownership rules to prevent one window from deleting
  another window's rows.
- Realtime events and mutation responses can use the dependency's synced-store
  write helpers and still participate in TanStack DB's normal live query
  updates.
- TanStack Query remains available for callers that need custom cache defaults,
  retry behavior, or integration with an existing `QueryClient`.

### Where the dependency constrains the adapter

- `QueryClient` is part of the adapter's public options and runtime, even for
  applications that would otherwise use only TanStack DB.
- Realtime lifecycle currently observes Query Cache events and reads the
  `loadSubsetOptions` metadata contract. This couples Realtime to the query
  implementation rather than to a Supabase-owned subscription abstraction.
- `supabaseCollectionOptions` wraps the dependency's `sync.sync` function to
  capture the collection instance for Realtime writes. That works, but it is a
  sign that the boundary should be isolated in one internal module.
- Correct pagination depends on Query DB Collection's ownership model and on
  generating distinct keys for distinct cursor and offset windows.
- Query data exists in both TanStack Query's cache and TanStack DB's synced
  store. The dependency maintains their relationship, but debugging lifecycle
  problems requires understanding both systems.

These are real coupling costs, but none currently prevents a Supabase feature.

## Options considered

### 1. Keep the dependency as-is

This has the smallest maintenance and regression risk. It preserves the public
`queryClient` option and all current cache behavior. The disadvantage is that
the adapter continues to reach across the boundary in `db.ts` for collection
capture and in `realtime.ts` for Query Cache inspection.

This is safe, but it leaves the coupling less explicit than it should be.

### 2. Keep it behind a narrower internal boundary

This retains Query DB Collection while concentrating all knowledge of its query
keys, metadata, observer lifecycle, and sync wrapper in one internal module.
PostgREST and Realtime code would depend on a small Supabase-owned interface
instead of reaching into Query DB Collection conventions independently.

Benefits:

- No user-facing API or behavior change.
- Lower migration cost if the dependency API changes later.
- Contract tests can describe the behavior Supabase relies on without copying
  the dependency's implementation tests.
- Realtime lifecycle can evolve without mixing transport code with generic
  query-cache plumbing.

Cost:

- A small internal refactor, with no immediate reduction in dependencies or
  bundle size.

This is the recommended option.

### 3. Replace it with a direct TanStack DB collection

A direct implementation would provide its own `sync.sync` function and
`loadSubset`/`unloadSubset` handlers. It could remove TanStack Query and make
the collection the only cache, giving Supabase complete control over loading,
subscriptions, and offline policy.

That apparent simplicity moves a large amount of lifecycle code into this
repository. A safe replacement must implement request deduplication, retries,
cancellation, error and readiness state, row ownership across overlapping
subsets, result diffing, observer reference counting, garbage collection,
pagination-window isolation, mutation reconciliation, and persisted ownership.
It would also remove or redefine the public `queryClient` option.

There is no demonstrated bug, performance limit, or offline requirement today
that justifies that cost. Replacing the dependency now would be a speculative
rewrite of mature generic behavior.

## Offline implications

Removing Query DB Collection is neither necessary nor sufficient for offline
support. Durable offline behavior still needs decisions about:

- where collection rows and pending mutations are persisted;
- how authenticated requests are replayed after reconnect;
- idempotency and duplicate writes;
- conflicts between queued writes and Realtime events;
- multi-tab ownership; and
- when RLS or an expired session makes a queued mutation permanently fail.

Those concerns can be layered around the current adapter. If a future
persistence backend requires access that Query DB Collection cannot expose,
that would be concrete evidence for revisiting replacement.

## Follow-up plan

1. Introduce one internal query-backed sync module that owns the
   `queryCollectionOptions` call, query key/metadata contract, collection
   capture, and Query Cache lifecycle hooks. Keep `supabaseCollectionOptions`
   and its options unchanged.
2. Add adapter-level contract tests for:
   - identical subset deduplication;
   - overlapping subset ownership and unload cleanup;
   - independent pagination windows;
   - current cancellation and late-response behavior;
   - initial and background error state;
   - optimistic mutation rollback and authoritative server rows; and
   - Realtime events racing with fetches and local mutations.
3. Treat Query DB Collection upgrades as behavior changes: run those contract
   tests in addition to the existing unit and end-to-end suites.
4. Revisit direct replacement only if at least one trigger below is met.

## Replacement triggers and migration outline

Replacement becomes reasonable if the current layer blocks a required
Supabase behavior, its cache duplication causes a measured resource problem,
TanStack Query must be removed from the public contract, or an offline backend
cannot be composed without violating correctness.

If that happens, the smallest safe migration is:

1. Preserve `supabaseCollectionOptions` and all options except any separately
   deprecated Query Client controls.
2. Implement a private direct sync adapter with the same query-key and row
   ownership rules.
3. Run both implementations through the contract suite, including overlapping
   filters, pagination, Realtime races, rollback, and persisted hydration.
4. Switch the internal implementation without changing collection call sites.
5. Remove `queryClient` only in a major release, with a migration note for
   callers that currently customize it.

Until a replacement trigger exists, the narrower wrapper provides most of the
architectural benefit without taking ownership of a second query lifecycle
implementation.
