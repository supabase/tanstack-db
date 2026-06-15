# @supabase-labs/tanstack-db

> **Experimental.** The Realtime integration is still being stabilized and may consume more Realtime messages than expected.
>
> Test in orgs on the free plan or with a spend cap. Set `realtime: false` on individual collections to opt out.

A [TanStack DB](https://tanstack.com/db/latest) collection adapter backed by [Supabase](https://supabase.com/). It connects queries, mutations, and Realtime subscriptions so your UI stays in sync with Postgres.

- **Live queries** - components re-render when data changes, no manual cache invalidation.
- **Optimistic mutations** - inserts, updates, and deletes apply instantly in the UI, then roll back automatically if the server rejects them.
- **Automatic Realtime sync** - when another user changes a row, every client with a live query on that collection sees the update without subscription code.
- **Fully typed** - collections derive their types from your schema, so queries and mutations are type-checked end to end.

Your Supabase database remains the source of truth. Postgres, RLS, Auth, and the rest of your stack stay unchanged. This is a frontend data layer that plugs into what you already have, with no migration required.

## Prerequisites

You need an existing Supabase project with the client library and environment variables configured. If you have not set that up yet, follow the [Supabase getting started guide](https://supabase.com/docs/guides/getting-started).

TanStack DB has [official libraries](https://tanstack.com/db/latest/docs/framework) for the major frontend frameworks. It does not yet support server-side rendering, so collections fetch on the client side.

## Installation

```bash
npm install @supabase-labs/tanstack-db @tanstack/react-db @supabase/supabase-js
```

## Quick Start

### 1. Enable Realtime For Synced Tables

Realtime is optional, but required if you want changes from other clients to appear automatically.

Enable Realtime for your table in the Supabase Table Editor, or run this in the SQL Editor:

```sql
alter publication supabase_realtime add table "public"."todos";
```

### 2. Define A Collection

In TanStack DB, a collection corresponds to a Postgres table. Create one collection for each table you want to access from your frontend:

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

### 3. Use Collections In Components

Query collections with `useLiveQuery`. Mutations are methods on the collection, so call `collection.update` or `collection.delete` directly. No hooks or mutation objects are required.

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

## API Reference

This package exports `supabaseCollectionOptions` and `queryOnce`. Everything else in the examples, including `createCollection`, `useLiveQuery`, and `eq`, comes from TanStack DB.

### `supabaseCollectionOptions(options)`

Builds the options object passed to TanStack DB's `createCollection`. It wires the collection's query, mutation, and optional Realtime sync behavior to a Supabase table.

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
| `tableName`   | `string`           | Yes      | Name of the Postgres table. Maps to the PostgREST endpoint.                                       |
| `schema`      | `StandardSchemaV1` | Yes      | Schema for a single row. Supports any [Standard Schema](https://standardschema.dev)-compatible library, including Zod and Valibot. |
| `keys`        | `string[]`         | Yes      | Column or columns that uniquely identify a row. Should match the primary key(s) on your table.                            |
| `supabase`    | `SupabaseClient`   | Yes      | Supabase client instance used for queries, mutations, and the Realtime subscription.                                   |
| `realtime`    | `boolean`          | No       | When `true`, subscribes to Postgres changes and reconciles inserts, updates, and deletes into the collection. Defaults to `false`. |
| `queryClient` | `QueryClient`      | No       | TanStack Query client. If omitted, a shared global client is used.                                                     |

**Returns** a collection options object to pass to `createCollection`.

---

### `queryOnce(callback, supabase)`

Runs a TanStack DB query once against Supabase and resolves with the result. It is non-reactive: it issues the needed requests and does not subscribe to changes.

```ts
import { eq } from "@tanstack/react-db";
import { queryOnce } from "@supabase-labs/tanstack-db";

const completedTodos = await queryOnce(
  (q) => q.from({ todo: todos }).where(({ todo }) => eq(todo.completed, true)),
  supabase
);
```

**Parameters**

| Parameter  | Type                  | Description                                            |
| ---------- | --------------------- | ------------------------------------------------------ |
| `callback` | `(q) => QueryBuilder` | Builds the query using the same API as `useLiveQuery`. |
| `supabase` | `SupabaseClient`      | Supabase client used to execute the request.           |

**Returns** a `Promise` that resolves to the query result, typed from the query you built.

Use `queryOnce` when you need a one-shot fetch, such as in server components, API routes, or form submissions where live updates are not needed.

Filters, ordering, `limit`, `offset`, joins, and aggregate functions (`count`, `sum`, `avg`, `min`, `max`) are pushed to PostgREST. Operations that cannot be pushed fall back to fetching matching rows and processing them client-side.

Fallback operations include `GROUP BY`, `HAVING`, `DISTINCT`, and computed `SELECT` expressions.

## How It Works

Most query operations are translated to PostgREST filters and run server-side. A handful of operations run client-side instead.

**Pushed To PostgREST**

| Operation                                            | Notes                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `FROM`                                               | Maps to the PostgREST table endpoint.                                             |
| `WHERE` (`eq`, `gt`, `gte`, `lt`, `lte`, `inArray`, `not`, `isNull`) | Translated to PostgREST filter syntax.                          |
| `AND` (multiple conditions or chained `.where`)      | Translated to PostgREST filter syntax.                                            |
| `ORDER BY` (on source columns)                       | Translated to PostgREST filter syntax.                                            |
| `LIMIT`                                              | Translated to PostgREST filter syntax.                                            |
| `JOIN`                                               | Each table is fetched separately. The join key is pushed as an `in` filter on the second query. |

**Evaluated Client-Side**

These operations fetch the required rows and process them in memory:

- `SELECT` column subsets, renaming, and computed fields (`upper`, `lower`, `concat`, `length`, `add`, `coalesce`)
- Aggregate functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` (except when using `queryOnce`)
- `GROUP BY` and `HAVING`
- `DISTINCT`
- `ORDER BY` on computed fields

## FAQ

<details>

<summary>Will this work with my RLS policies?</summary>

Yes. `tanstack-db` goes through PostgREST and Realtime, so your existing RLS policies apply automatically. To enable Realtime sync for a table, run:

```sql
alter publication supabase_realtime add table "public"."todos";
```

</details>

<details>

<summary>What if I do not use RLS?</summary>

Without RLS, all Realtime changes broadcast to every client. Depending on whether your app is public or private, that may not be what you want.

Set `realtime: false` on specific collections. You will still get optimistic mutations and automatic cache invalidation.

</details>

<details>

<summary>Can I use <code>tanstack-db</code> and <code>supabase-js</code> in parallel?</summary>

Yes. This library uses `supabase-js` under the hood, so they are compatible. Data fetched directly through `supabase-js` will not appear in the `tanstack-db` cache.

Use `supabase-js` as a fallback for features TanStack DB does not cover, such as database functions through `.rpc` or complex `GROUP BY` queries.

</details>

<details>

<summary>Will this work with a custom API server?</summary>

This library targets Supabase and PostgREST tables. For custom backends, write your own TanStack DB collection. The [TanStack DB docs](https://tanstack.com/db/latest) cover collection adapters.

</details>

## Roadmap

- Generate collection definitions from your database schema via the Supabase CLI, keeping them in sync as your schema evolves.
- Add `OR` conditions and nested `AND`/`OR` support.
