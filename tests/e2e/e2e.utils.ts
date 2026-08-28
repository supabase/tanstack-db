import type { StandardSchemaV1 } from "@standard-schema/spec"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createCollection } from "@tanstack/db"
import { QueryClient } from "@tanstack/query-core"
import { supabaseCollectionOptions } from "../../src/index"
import { todosSchema, usersSchema, usersTodosSchema } from "../test.utils"

type E2eEnv = {
  url: string
  anonKey: string
}

export const getEnv = (): E2eEnv => {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY

  if (!(url && anonKey)) {
    throw new Error(
      "Missing e2e environment (SUPABASE_URL / SUPABASE_ANON_KEY). The global setup should populate these."
    )
  }

  return { url, anonKey }
}

// A fresh Supabase client. Each realtime "other user" write in the tests uses a
// separate client so the change arrives purely over realtime.
export const makeSupabase = (): SupabaseClient => {
  const { url, anonKey } = getEnv()
  return createClient(url, anonKey)
}

type CollectionOptions = {
  realtime?: boolean
}

// Each collection gets its own QueryClient: the realtime channel registry in
// src/db.ts is keyed by QueryClient, so a fresh one per collection prevents
// channels leaking across tests.
const buildCollection = <TSchema extends StandardSchemaV1>(
  tableName: string,
  keys: Array<keyof StandardSchemaV1.InferOutput<TSchema> & string>,
  schema: TSchema,
  { realtime = false }: CollectionOptions
) => {
  const supabase = makeSupabase()
  const queryClient = new QueryClient()
  const collection = createCollection(
    supabaseCollectionOptions({
      tableName,
      keys,
      schema,
      supabase,
      queryClient,
      realtime,
    })
  )
  return { collection, supabase, queryClient }
}

export const makeUsersCollection = (options: CollectionOptions = {}) =>
  buildCollection("users", ["id"], usersSchema, options)

export const makeTodosCollection = (options: CollectionOptions = {}) =>
  buildCollection("todos", ["id"], todosSchema, options)

export const makeUsersTodosCollection = (options: CollectionOptions = {}) =>
  buildCollection(
    "users_todos",
    ["user_id", "todo_id"],
    usersTodosSchema,
    options
  )
