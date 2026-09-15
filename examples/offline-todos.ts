import type { SupabaseClient } from "@supabase/supabase-js"
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence"
import {
  type Collection,
  createCollection,
  type PendingMutation,
  type Transaction,
} from "@tanstack/db"
import {
  NonRetriableError,
  startOfflineExecutor,
} from "@tanstack/offline-transactions"
import { z } from "zod"
import { supabaseCollectionOptions } from "../src/index"

export const todoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  completed: z.boolean(),
})
const todoChangesSchema = todoSchema.partial()

export type Todo = z.infer<typeof todoSchema>

export type TodoMutation = Pick<
  PendingMutation<Todo>,
  "changes" | "key" | "modified" | "type"
>

const parseTodoMutation = (
  mutation: PendingMutation<Record<string, unknown>>
): TodoMutation => ({
  type: mutation.type,
  key: z.string().parse(mutation.key),
  modified: todoSchema.parse(mutation.modified),
  changes: todoChangesSchema.parse(mutation.changes),
})

type MutationResponse = {
  error: { message: string } | null
  status: number
}

type OfflineTodos = {
  todos: Collection<Todo, string | number>
  addTodo: (variables: { title: string }) => Transaction
  updateTodo: (variables: {
    id: string
    changes: Partial<Pick<Todo, "completed" | "title">>
  }) => Transaction
  deleteTodo: (id: string) => Transaction
  dispose: () => Promise<void>
}

const throwMutationError = ({ error, status }: MutationResponse): void => {
  if (!error) {
    return
  }

  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    throw new NonRetriableError(error.message)
  }

  throw new Error(error.message)
}

/**
 * Replays one queued mutation through PostgREST.
 *
 * Inserts use a client-generated UUID and upsert so retrying the same queued
 * transaction cannot create a duplicate row. PostgREST has no generic
 * idempotency-key contract for these table mutations.
 */
export const syncTodoMutation = async (
  supabase: SupabaseClient,
  mutation: TodoMutation
): Promise<void> => {
  if (mutation.type === "insert") {
    const response = await supabase
      .from("todos")
      .upsert(mutation.modified, { onConflict: "id" })
    throwMutationError(response)
    return
  }

  if (mutation.type === "update") {
    const response = await supabase
      .from("todos")
      .update(mutation.changes)
      .eq("id", mutation.key)
    throwMutationError(response)
    return
  }

  const response = await supabase.from("todos").delete().eq("id", mutation.key)
  throwMutationError(response)
}

export const createOfflineTodos = async (
  supabase: SupabaseClient
): Promise<OfflineTodos> => {
  const databaseName = "supabase-todos.sqlite"
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName,
  })
  const coordinator = new BrowserCollectionCoordinator({ dbName: databaseName })
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator,
  })

  const persistedOptions = persistedCollectionOptions<
    Todo,
    string | number,
    typeof todoSchema
  >({
    ...supabaseCollectionOptions({
      tableName: "todos",
      keys: ["id"],
      schema: todoSchema,
      supabase,
      realtime: true,
    }),
    persistence,
    schemaVersion: 1,
  })
  const todos = createCollection({
    ...persistedOptions,
    // The 0.1 persistence package's local-only overload makes schema optional.
    // Restating it preserves schema inference when wrapping a synced collection.
    schema: todoSchema,
  })

  const syncTodos = async ({
    transaction,
  }: Parameters<
    Parameters<typeof startOfflineExecutor>[0]["mutationFns"][string]
  >[0]) => {
    for (const mutation of transaction.mutations) {
      await syncTodoMutation(supabase, parseTodoMutation(mutation))
    }

    // Realtime only carries changes published after it reconnects. Refetch
    // after replay so the collection reconciles with the server first.
    await todos.utils.refetch()
  }

  const offline = startOfflineExecutor({
    collections: { todos },
    mutationFns: { syncTodos },
  })

  await offline.waitForInit()

  const addTodo = offline.createOfflineAction<{ title: string }>({
    mutationFnName: "syncTodos",
    onMutate: ({ title }) => {
      todos.insert({
        id: crypto.randomUUID(),
        title,
        completed: false,
      })
    },
  })

  const updateTodo = offline.createOfflineAction<{
    id: string
    changes: Partial<Pick<Todo, "completed" | "title">>
  }>({
    mutationFnName: "syncTodos",
    onMutate: ({ id, changes }) => {
      todos.update(id, (draft) => {
        Object.assign(draft, changes)
      })
    },
  })

  const deleteTodo = offline.createOfflineAction<string>({
    mutationFnName: "syncTodos",
    onMutate: (id) => {
      todos.delete(id)
    },
  })

  return {
    todos,
    addTodo,
    updateTodo,
    deleteTodo,
    async dispose() {
      offline.dispose()
      todos.cleanup()
      coordinator.dispose()
      await database.close?.()
    },
  }
}
