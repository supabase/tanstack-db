import { createClient } from "@supabase/supabase-js"
import { createCollection, liveQueryCollectionOptions } from "@tanstack/db"
import { expect, vi } from "vitest"
import { z } from "zod"
import { supabaseCollectionOptions } from "../src/index"

// --- Schemas ---

export const usersSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
})

export const usersTodosSchema = z.object({
  user_id: z.number(),
  todo_id: z.number(),
})

export const todosSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  completed: z.boolean(),
})

// --- Mock infrastructure ---

export const SUPABASE_URL = "http://localhost:54321"
export const SUPABASE_KEY = "test-key"

export const mockResponses: Record<string, any[]> = {
  users: [
    { id: "user_1", name: "Alice", email: "alice@test.com", active: true },
  ],
  users_todos: [{ user_id: "user_1", todo_id: "todo_1" }],
  todos: [
    {
      id: "todo_1",
      title: "Buy milk",
      description: "From the store",
      completed: false,
    },
  ],
}

export function createMockFetch() {
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString())
    const table = url.pathname.replace("/rest/v1/", "")
    const method = init?.method ?? "GET"

    // For insert/update requests, echo the request body back as the
    // "representation" so `.select().single()` has something schema-shaped
    // to parse, mirroring what PostgREST would return.
    if (method === "POST" || method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    }

    const response = mockResponses[table] ?? []
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  })
}

/** Extract the headers of a captured `fetch` call as a `Headers` instance. */
export function getRequestHeaders(
  mockFetch: ReturnType<typeof createMockFetch>,
  callIndex = 0
): Headers {
  const init = mockFetch.mock.calls[callIndex]?.[1]
  return new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
}

export function createMockedUsersCollection(mockFetch: typeof fetch) {
  return createCollection(
    supabaseCollectionOptions({
      tableName: "users",
      keys: ["id"],
      schema: usersSchema,
      supabase: createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { fetch: mockFetch },
      }),
    })
  )
}

export function createMockedUsersTodosCollection(mockFetch: typeof fetch) {
  return createCollection(
    supabaseCollectionOptions({
      tableName: "users_todos",
      keys: ["user_id", "todo_id"],
      schema: usersTodosSchema,
      supabase: createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { fetch: mockFetch },
      }),
    })
  )
}

export function createMockedTodosCollection(mockFetch: typeof fetch) {
  return createCollection(
    supabaseCollectionOptions({
      tableName: "todos",
      keys: ["id"],
      schema: todosSchema,
      supabase: createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { fetch: mockFetch },
      }),
    })
  )
}

// --- Query helpers ---

export async function queryResult(
  queryFn: Parameters<typeof liveQueryCollectionOptions>[0]["query"]
) {
  const opts = liveQueryCollectionOptions({ query: queryFn })
  const collection = createCollection(
    opts as Extract<typeof opts, { singleResult?: never }>
  )
  await collection.preload()
  const data = await collection.toArrayWhenReady()
  collection.cleanup()
  return data
}

// --- Assertion helpers ---

export function normalizeFetchUrl(raw: string | URL | Request): string {
  const url = new URL(typeof raw === "string" ? raw : raw.toString())
  url.searchParams.sort()
  return `${url.pathname}${decodeURIComponent(url.search)}`
}

export function expectFetchUrls(
  mockFetch: ReturnType<typeof createMockFetch>,
  expectedPaths: string[]
) {
  const actual = mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))
  const expected = expectedPaths.map((p) =>
    normalizeFetchUrl(new URL(p, SUPABASE_URL))
  )
  expect([...actual]).toEqual([...expected])
}
