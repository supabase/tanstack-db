import { createClient } from "@supabase/supabase-js"
import { createCollection, liveQueryCollectionOptions } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
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

// --- Realtime mock infrastructure ---

type MockChannelOnCall = {
  type: string
  config: { event: string; schema: string; table: string; filter?: string }
  handler: (payload: any) => void
}

export type MockChannel = {
  onCalls: MockChannelOnCall[]
  on: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  /**
   * Reports a subscription status (SUBSCRIBED by default) when the channel was
   * created with `autoSubscribe: false`.
   */
  confirmSubscribed: (status?: string) => void
}

export function createMockChannel({
  autoSubscribe = true,
}: {
  autoSubscribe?: boolean
} = {}): MockChannel {
  const onCalls: MockChannelOnCall[] = []
  let pending: ((status: string) => void) | undefined

  const channel: MockChannel = {
    onCalls,
    on: vi.fn((type: string, config: any, handler: (payload: any) => void) => {
      onCalls.push({ type, config, handler })
      return channel
    }),
    // The adapter drives channel swaps and the rejection fallback off the
    // subscription status, so the mock reports one like the real channel does.
    subscribe: vi.fn((callback?: (status: string) => void) => {
      if (autoSubscribe) {
        callback?.("SUBSCRIBED")
      } else {
        pending = callback
      }
      return channel
    }),
    confirmSubscribed: (status = "SUBSCRIBED") => {
      pending?.(status)
      pending = undefined
    },
  }
  return channel
}

/** Returns the postgres_changes listeners registered for a given event. */
export function listenersFor(mockChannel: MockChannel, event: string) {
  return mockChannel.onCalls.filter((call) => call.config.event === event)
}

/** The filter strings of a given event's listeners (null when unfiltered). */
export function filtersFor(
  mockChannel: MockChannel,
  event: string
): Array<string | null> {
  return listenersFor(mockChannel, event).map(
    (call) => call.config.filter ?? null
  )
}

/** Dispatches a payload to every listener registered for its event type. */
export function emit(mockChannel: MockChannel, payload: any) {
  for (const call of listenersFor(mockChannel, payload.eventType)) {
    call.handler(payload)
  }
}

export function createRealtimeUsersCollection(
  mockFetch: typeof fetch,
  mockChannel: MockChannel | (() => MockChannel),
  options: { realtimeUseFilter?: boolean } = {}
) {
  // A fresh QueryClient keeps the module-level realtime registry in db.ts
  // isolated per test.
  const queryClient = new QueryClient()
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: mockFetch },
  })
  // The real client would open a live WebSocket, so stub the realtime surface.
  supabase.channel = vi.fn(() =>
    typeof mockChannel === "function" ? mockChannel() : mockChannel
  ) as unknown as typeof supabase.channel
  supabase.removeChannel = vi.fn() as unknown as typeof supabase.removeChannel

  const collection = createCollection(
    supabaseCollectionOptions({
      tableName: "users",
      keys: ["id"],
      schema: usersSchema,
      supabase,
      realtime: true,
      realtimeUseFilter: options.realtimeUseFilter,
      queryClient,
    })
  )

  return { collection, supabase, queryClient }
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
