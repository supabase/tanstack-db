import { createClient } from "@supabase/supabase-js"
import { NonRetriableError } from "@tanstack/offline-transactions"
import { describe, expect, test, vi } from "vitest"
import {
  syncTodoMutation,
  type Todo,
  type TodoMutation,
} from "../examples/offline-todos"
import { SUPABASE_KEY, SUPABASE_URL } from "./test.utils"

const todo: Todo = {
  id: "todo-1",
  title: "Buy milk",
  completed: false,
}

const mutation = (
  value: Partial<TodoMutation> & Pick<TodoMutation, "type">
): TodoMutation => ({
  key: todo.id,
  modified: todo,
  changes: {},
  ...value,
})

const createSupabase = (mockFetch: typeof fetch) =>
  createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: mockFetch },
  })

describe("offline Supabase example", () => {
  test.each([
    {
      name: "upserts inserts with their stable client-generated id",
      mutation: mutation({ type: "insert" }),
      method: "POST",
      path: "/rest/v1/todos?on_conflict=id",
      body: todo,
    },
    {
      name: "updates a todo by primary key",
      mutation: mutation({
        type: "update",
        changes: { completed: true },
      }),
      method: "PATCH",
      path: "/rest/v1/todos?id=eq.todo-1",
      body: { completed: true },
    },
    {
      name: "deletes a todo by primary key",
      mutation: mutation({ type: "delete" }),
      method: "DELETE",
      path: "/rest/v1/todos?id=eq.todo-1",
      body: undefined,
    },
  ])("$name", async ({ mutation: pending, method, path, body }) => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    await syncTodoMutation(createSupabase(mockFetch), pending)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [input, init] = mockFetch.mock.calls[0] ?? []
    expect(
      new URL(String(input)).pathname + new URL(String(input)).search
    ).toBe(path)
    expect(init?.method).toBe(method)
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(body)
  })

  test("marks permanent PostgREST failures as non-retriable", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "RLS rejected the mutation" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    )

    await expect(
      syncTodoMutation(createSupabase(mockFetch), mutation({ type: "delete" }))
    ).rejects.toBeInstanceOf(NonRetriableError)
  })

  test("leaves transient PostgREST failures retriable", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    )

    await expect(
      syncTodoMutation(createSupabase(mockFetch), mutation({ type: "update" }))
    ).rejects.not.toBeInstanceOf(NonRetriableError)
  })
})
