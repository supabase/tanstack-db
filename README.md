# @supabase-labs/tanstack-db

> [!NOTE]
> This is an experimental package. The Realtime integration is still being stabilised and may consume more Realtime messages than expected. Test in orgs on the free plan or with a spend cap. You can also set `realtime: false` on specific collections to opt out of automatic Realtime sync.

A [TanStack DB](https://tanstack.com/db/latest) collection backed by [Supabase](https://supabase.com/). It wires queries, mutations, and Realtime subscriptions to your Supabase backend, giving you reactive state that stays in sync with your Postgres database.

- **Live queries** — query collections with plain JavaScript. Every component re-renders automatically when data changes; no manual cache invalidation needed.
- **Optimistic mutations** — inserts, updates, and deletes apply instantly in the UI and roll back automatically if the server rejects them.
- **Automatic Realtime sync** — when another user changes a row, every client with a live query on that collection sees the update immediately, with no subscription code to write.
- **Fully typed** — collections derive their types from your schema, so queries and mutations are type-checked end to end.

Your Supabase database remains the source of truth. Postgres, RLS, Auth, and the rest of the stack are unchanged - this is a frontend data layer that plugs into what's already there with no migration required.

## Prerequisites

You need to have a project already setup with Supabase. This includes client libraries and environment variables. You can find a guide for your framework [here](https://supabase.com/docs/guides/getting-started).

## Installation

```bash
npm install @supabase-labs/tanstack-db @tanstack/react-db @supabase/supabase-js
```

## Quick start

### 1. Enable Realtime on the tables you want synced (optional)

Run the following snippet in your SQL Editor to enable realtime for your table:

```sql
alter publication supabase_realtime add table "public"."todos";
```

### 2. Define a collection

For each table that you want to access in your frontend app, you need to define it like so:

```ts
import { createCollection } from "@tanstack/react-db";
import { supabaseCollectionOptions } from "@supabase-labs/tanstack-db";
import { createClient } from "@supabase/supabase-js";
import { z } from 'zod';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const todosSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  completed: z.boolean(),
})

const todos = createCollection(
  supabaseCollectionOptions({
    tableName: "todos",
    schema: todosSchema,
    keys: ["id"], // should match your primary key(s)
    supabase,
    realtime: true,
  }),
);
```

### 3. Use the collections in your components

The collections you've defined can then be used with `useLiveQuery` 

```tsx
import { useLiveQuery, eq } from "@tanstack/react-db";
import { todos } from '../db';

const ActiveTodoList = () => {
  // fetch the data in your components
  const { data: activeTodosWithAuthors, isLoading } = useLiveQuery((q) =>
    q.from({ todo: todos })
    .join({ user: users }, ({ todo, user }) => eq(todo.user_id, user.id))
    .where(({ todo }) => eq(todo.completed, false))
    .orderBy(({ todo }) => todo.priority, "desc"),
    // dependency list which will cause the query to refetch
    []
  );

  // function to update a todo, will rerender without waiting for the result
  const updateTodo = (id: string, checked: boolean) => {
    todos.update(id, (draft) => {
      draft.checked = checked
    })
  }

  const deleteTodo = (id: string) => {
    todos.delete(id)
  }

  ...
}
```
Updates and deletions are done via imperative methods - you don't need to define hooks or mutations, you just call `collection.update` or `collection.delete`.

## API reference

The package exports two functions: `supabaseCollectionOptions` and `queryOnce`. Everything else in the examples (`createCollection`, `useLiveQuery`, `eq`, …) comes from TanStack DB.

### `supabaseCollectionOptions(options)`

Builds the options object you pass to TanStack DB's `createCollection`. It wires the collection's query, mutation, and (optionally) Realtime sync to a Supabase table.

```ts
const todos = createCollection(
  supabaseCollectionOptions({
    tableName: "todos",
    schema: todoSchema,
    keys: ["id"],
    supabase,
    realtime: true,
  }),
);
```

**Options**

| Option        | Type                | Required | Description |
| ------------- | ------------------- | -------- | ----------- |
| `tableName`   | `string`            | Yes      | Name of the Postgres table. Maps to the PostgREST endpoint and the Realtime channel. |
| `schema`      | `StandardSchemaV1`  | Yes      | Schema describing a row — any [Standard Schema](https://standardschema.dev) (Zod, Valibot, …). Drives row typing and validation. |
| `keys`        | `string[]`          | Yes      | Column(s) that uniquely identify a row. Should match the unique keys you've defined for your table |
| `supabase`    | `SupabaseClient`    | Yes      | The Supabase client instance. Used for queries, mutations, and the Realtime subscription. |
| `realtime`    | `boolean`           | No       | When `true`, subscribes to Postgres changes for the table and reconciles inserts, updates, and deletes into the collection. Defaults to `false`. |
| `queryClient` | `QueryClient`       | No       | A TanStack Query client. If omitted, a shared global client is used. |

**Returns** — a collection options object to pass to `createCollection`.

### `queryOnce(callback, supabase)`

Runs a TanStack DB query once against Supabase and resolves with the result. Non-reactive — it issues one request and doesn't subscribe to changes.

```ts
const completedTodos = await queryOnce(
  (q) => q.from({ todo: todos }).where(({ todo }) => eq(todo.completed, true)),
  supabase
);
```

**Parameters**

| Parameter  | Type                  | Description |
| ---------- | --------------------- | ----------- |
| `callback` | `(q) => QueryBuilder` | Builds the query using the same query builder API as `useLiveQuery`. |
| `supabase` | `SupabaseClient`      | The Supabase client used to execute the request. |

**Returns** — a `Promise` resolving to the query result, typed from the query you built.

Use `queryOnce` when you need a single, non-reactive fetch — for example in server components, API routes, or form submissions where live updates aren't needed.

```ts
import { eq } from "@tanstack/react-db";
import { queryOnce } from "@supabase-labs/tanstack-db";

// fetch all matching rows
const completedTodos = await queryOnce(
  (q) => q.from({ todo: todos }).where(({ todo }) => eq(todo.completed, true)),
  []
);
```

Unlike `useLiveQuery`, `queryOnce` issues one request and resolves with the result — it doesn't subscribe to changes. Filters, ordering, `limit`, `offset`, joins, and aggregate functions (`count`, `sum`, `avg`, `min`, `max`) are pushed server-side. Operations that can't be pushed (`GROUP BY`, `HAVING`, `DISTINCT`, computed `SELECT` expressions) fall back to fetching the rows and processing them client-side.

## How it works

### What gets pushed to PostgREST

| Feature                                               | Server-side | Notes |
| ----------------------------------------------------- | ----------- | ----- |
| `FROM`                                                | Yes         | Maps to the PostgREST table endpoint. |
| `WHERE` (eq, gt, gte, lt, lte, inArray, not, isNull)  | Yes         | Translated to PostgREST syntax. |
| `AND` (multiple conditions / chained `.where`)        | Yes         | Translated to PostgREST syntax. |
| `ORDER BY` (on source columns)                        | Yes         | Translated to PostgREST syntax. |
| `LIMIT`                                               | Yes         | Translated to PostgREST syntax. |
| `JOIN`                                                | Yes         | Each table is fetched separately; the join key is pushed as an `in` filter on the second query. |

### What runs client-side

These operations fetch all required rows and evaluate them in memory:

- `SELECT` column subsets, renaming, and computed fields (`upper`, `lower`, `concat`, `length`, `add`, `coalesce`)
- Aggregate functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` (except when using `queryOnce`)
- `GROUP BY` and `HAVING`
- `DISTINCT`
- `ORDER BY` on computed fields

## FAQ

### Will this work with my RLS policies?

Yes — no changes to your project are required. `tanstack-db` goes through PostgREST and Realtime, so your existing RLS policies apply automatically. To enable Realtime sync for a table, run:

```sql
alter publication supabase_realtime add table "public"."todos";
```

### What if I don't use RLS?

Without RLS, all Realtime changes broadcast to every client. Depending on whether your app is public or private, that may not be what you want. Set `realtime: false` on specific collections and you still get optimistic mutations and automatic cache updates.

### Can I use `tanstack-db` and `supabase-js` in parallel?

Yes. This library uses `supabase-js` under the hood, so they're fully compatible. Data fetched directly through `supabase-js` won't appear in the `tanstack-db` cache.

### Will this work with a custom API server?

This library targets Supabase/PostgREST tables. For custom backends, write your own TanStack DB collection — see the [TanStack DB docs](https://tanstack.com/db/latest) on building collection adapters to get the same live-query and optimistic-mutation benefits.

## Roadmap

- generate collection definitions from your database schema via the Supabase CLI, keeping them in sync as your schema evolves. 
- `OR` conditions and nested `AND`/`OR` support.