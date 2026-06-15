# @supabase-labs/tanstack-db

> **Experimental.** The Realtime integration is still being stabilised and may consume more Realtime messages than expected. Test in orgs on the free plan or with a spend cap. Set `realtime: false` on individual collections to opt out.

A [TanStack DB](https://tanstack.com/db/latest) collection backed by [Supabase](https://supabase.com/). It wires queries, mutations, and Realtime subscriptions to your Supabase backend so your UI stays in sync with Postgres automatically.

- **Live queries** - every component re-renders when data changes. No manual cache invalidation.
- **Optimistic mutations** - inserts, updates, and deletes apply instantly in the UI and roll back automatically if the server rejects them.
- **Automatic Realtime sync** - when another user changes a row, every client with a live query on that collection sees the update immediately, with no subscription code to write.
- **Fully typed** - collections derive their types from your schema, so queries and mutations are type-checked end to end.

Your Supabase database remains the source of truth. Postgres, RLS, Auth, and the rest of the stack are untouched, this is a frontend data layer that plugs into what's already there with no migration required.

## Prerequisites

On the Supabase side, you need an existing Supabase project with the client library and environment variables configured. If you haven't done that yet, follow the [getting started guide](https://supabase.com/docs/guides/getting-started) for your framework.

On the Tanstack DB side, it has [official libraries](https://tanstack.com/db/latest/docs/framework) for the major frontend frameworks. Please note, Tanstack DB doesn't yet support server-side rendering, so it will only fetch on client side.

## Installation

```bash
npm install @supabase-labs/tanstack-db @tanstack/react-db @supabase/supabase-js
```

## Quick start

### 1. Enable Realtime on the tables you want synced (optional)

Enable Realtime for your your table in Table Editor or run this in your SQL Editor:

```sql
alter publication supabase_realtime add table "public"."todos";
```

### 2. Define a collection

In Tanstack DB, collection corresponds to tables in Postgres. Create one collection per table you want to access in your frontend:

```ts
import { createCollection } from "@tanstack/react-db";
import { supabaseCollectionOptions } from "@supabase-labs/tanstack-db";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const todosSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  completed: z.boolean(),
});

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

### 3. Use collections in your components

Query collections with `useLiveQuery`. Mutations are methods on the collection, call `collection.update` or `collection.delete` directly, no hooks or mutation objects required.

```tsx
import { useLiveQuery, eq } from "@tanstack/react-db";
import { todos } from "../db";

const ActiveTodoList = () => {
  const { data: activeTodosWithAuthors, isLoading } = useLiveQuery(
    (q) =>
      q
        .from({ todo: todos })
        .join({ user: users }, ({ todo, user }) => eq(todo.user_id, user.id))
        .where(({ todo }) => eq(todo.completed, false))
        .orderBy(({ todo }) => todo.priority, "desc"),
    [] // re-run the query when these dependencies change
  );

  // applies instantly in the UI; rolls back if the server rejects it
  const updateTodo = (id: string, checked: boolean) => {
    todos.update(id, (draft) => {
      draft.checked = checked;
    });
  };

  const deleteTodo = (id: string) => {
    todos.delete(id);
  };

  // ...
};
```

## API reference

This package exports two functions: `supabaseCollectionOptions` and `queryOnce`. Everything else in the examples (`createCollection`, `useLiveQuery`, `eq`, …) comes from TanStack DB.

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

| Option        | Type               | Required | Description                                                                                                            |
| ------------- | ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tableName`   | `string`           | Yes      | Name of the Postgres table. Maps to the PostgREST endpoint and the Realtime channel.                                   |
| `schema`      | `StandardSchemaV1` | Yes      | Schema for a single row - any [Standard Schema](https://standardschema.dev) compatible library (Zod, Valibot, …).      |
| `keys`        | `string[]`         | Yes      | Column(s) that uniquely identify a row. Should match the primary key(s) on your table.                                 |
| `supabase`    | `SupabaseClient`   | Yes      | The Supabase client instance used for queries, mutations, and the Realtime subscription.                               |
| `realtime`    | `boolean`          | No       | When `true`, subscribes to Postgres changes and reconciles inserts, updates, and deletes into the collection. Defaults to `false`. |
| `queryClient` | `QueryClient`      | No       | A TanStack Query client. If omitted, a shared global client is used.                                                   |

**Returns** a collection options object to pass to `createCollection`.

---

### `queryOnce(callback, supabase)`

Runs a TanStack DB query once against Supabase and resolves with the result. Non-reactive - it issues one request and does not subscribe to changes.

```ts
import { eq } from "@tanstack/react-db";
import { queryOnce } from "@supabase-labs/tanstack-db";

const completedTodos = await queryOnce(
  (q) => q.from({ todo: todos }).where(({ todo }) => eq(todo.completed, true)),
  supabase
);
```

**Parameters**

| Parameter  | Type                  | Description                                                              |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| `callback` | `(q) => QueryBuilder` | Builds the query using the same API as `useLiveQuery`.                   |
| `supabase` | `SupabaseClient`      | The Supabase client used to execute the request.                         |

**Returns** a `Promise` that resolves to the query result, typed from the query you built.

Use `queryOnce` when you need a one-shot fetch - server components, API routes, or form submissions where live updates aren't needed. Filters, ordering, `limit`, `offset`, joins, and aggregate functions (`count`, `sum`, `avg`, `min`, `max`) are pushed to PostgREST. Operations that can't be pushed (`GROUP BY`, `HAVING`, `DISTINCT`, computed `SELECT` expressions) fall back to fetching all matching rows and processing them client-side.

## How it works

Most query operations are translated to PostgREST filters and run server-side. A handful run client-side instead.

**Pushed to PostgREST**

| Operation                                            | Notes                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `FROM`                                               | Maps to the PostgREST table endpoint.                                             |
| `WHERE` (`eq`, `gt`, `gte`, `lt`, `lte`, `inArray`, `not`, `isNull`) | Translated to PostgREST filter syntax.                          |
| `AND` (multiple conditions / chained `.where`)       | Translated to PostgREST filter syntax.                                            |
| `ORDER BY` (on source columns)                       | Translated to PostgREST filter syntax.                                            |
| `LIMIT`                                              | Translated to PostgREST filter syntax.                                            |
| `JOIN`                                               | Each table is fetched separately; the join key is pushed as an `in` filter on the second query. |

**Evaluated client-side**

These operations fetch all required rows and process them in memory:

- `SELECT` column subsets, renaming, and computed fields (`upper`, `lower`, `concat`, `length`, `add`, `coalesce`)
- Aggregate functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` (except when using `queryOnce`)
- `GROUP BY` and `HAVING`
- `DISTINCT`
- `ORDER BY` on computed fields

## FAQ

**Will this work with my RLS policies?**

Yes. `tanstack-db` goes through PostgREST and Realtime, so your existing RLS policies apply automatically with no changes to your project. To enable Realtime sync for a table, run:

```sql
alter publication supabase_realtime add table "public"."todos";
```

**What if I don't use RLS?**

Without RLS, all Realtime changes broadcast to every client. Depending on whether your app is public or private, that may not be what you want. Set `realtime: false` on specific collections - you'll still get optimistic mutations and automatic cache updates.

**Can I use `tanstack-db` and `supabase-js` in parallel?**

Yes. This library uses `supabase-js` under the hood, so they're fully compatible. Data fetched directly through `supabase-js` won't appear in the `tanstack-db` cache. You can use `supabase-js` as a fallback if Tanstack DB doesn't support your need like call database functions via the `.rpc` method or write complex `group by` and aggregate functions.

**Will this work with a custom API server?**

This library targets Supabase/PostgREST tables. For custom backends, write your own TanStack DB collection - the [TanStack DB docs](https://tanstack.com/db/latest) cover building collection adapters to get the same live-query and optimistic-mutation benefits.

## Roadmap

- Generate collection definitions from your database schema via the Supabase CLI, keeping them in sync as your schema evolves.
- `OR` conditions and nested `AND`/`OR` support.