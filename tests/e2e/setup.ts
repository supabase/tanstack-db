import { createClient } from "@supabase/supabase-js"
import { beforeEach, inject } from "vitest"

// Data reset uses the service_role (admin) client, which bypasses RLS.
const admin = createClient(
  inject("supabaseUrl"),
  inject("supabaseServiceRoleKey"),
  { auth: { persistSession: false } }
)

// reset_e2e() truncates all test tables (restart identity) and re-seeds the
// fixture rows in a single transactional round trip, so every test starts from
// the same state: Alice (id 1, active) and Bob (id 2, inactive).
beforeEach(async () => {
  const { error } = await admin.rpc("reset_e2e")
  if (error) {
    throw new Error(`e2e reset failed: ${error.message}`)
  }
})
