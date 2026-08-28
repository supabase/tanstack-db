import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { beforeEach, inject } from "vitest"

// Bridge the anon credentials published by the global setup into the environment
// so the shared helpers (e2e.utils.ts) can read them from process.env.
process.env.SUPABASE_URL = inject("supabaseUrl")
process.env.SUPABASE_ANON_KEY = inject("supabaseAnonKey")

// Data setup uses the service_role (admin) client, which bypasses RLS.
const admin: SupabaseClient = createClient(
  inject("supabaseUrl"),
  inject("supabaseServiceRoleKey"),
  { auth: { persistSession: false } }
)

const assertNoError = (label: string, error: { message: string } | null) => {
  if (error) {
    throw new Error(`e2e seed: ${label} failed: ${error.message}`)
  }
}

// Reset to a known, deterministic fixture before every test. reset_e2e() runs
// TRUNCATE ... RESTART IDENTITY, so seeded rows always start at id 1.
beforeEach(async () => {
  const { error: resetError } = await admin.rpc("reset_e2e")
  assertNoError("reset", resetError)

  const { error: usersError } = await admin.from("users").insert([
    { name: "Alice", email: "alice@test.com", active: true },
    { name: "Bob", email: "bob@test.com", active: false },
  ])
  assertNoError("seed users", usersError)

  const { error: todosError } = await admin.from("todos").insert([
    { title: "Buy milk", description: "From the store", completed: false },
    { title: "Walk dog", description: "Around the block", completed: true },
  ])
  assertNoError("seed todos", todosError)
})
