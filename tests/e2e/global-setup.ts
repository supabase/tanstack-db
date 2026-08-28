import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createClient } from "@supabase/supabase-js"
import type { TestProject } from "vitest/node"

const execFileAsync = promisify(execFile)

// Generous enough for a cold CI runner to pull the container images.
const START_TIMEOUT_MS = 600_000
const STOP_TIMEOUT_MS = 120_000

// Realtime warm-up: a freshly started realtime container needs a moment before
// its Postgres replication is fully wired, so the first subscription can miss
// changes. We subscribe and repeatedly insert a sentinel row until an event is
// actually delivered, guaranteeing realtime is live before any test runs.
const WARMUP_TIMEOUT_MS = 60_000
const WARMUP_ATTEMPTS = 40
const WARMUP_POKE_INTERVAL_MS = 1000
const WARMUP_SENTINEL_ID = 2_000_000_000

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// Values published to the e2e test workers via `inject(...)` (see setup.ts).
declare module "vitest" {
  interface ProvidedContext {
    supabaseAnonKey: string
    supabaseServiceRoleKey: string
    supabaseUrl: string
  }
}

type SupabaseStatus = {
  API_URL?: string
  ANON_KEY?: string
  SERVICE_ROLE_KEY?: string
}

const runSupabase = (args: string[], timeout: number) =>
  execFileAsync("pnpm", ["exec", "supabase", ...args], {
    cwd: process.cwd(),
    timeout,
  })

// Returns the parsed `supabase status` JSON, or null when no stack is running.
const readStatus = async (): Promise<SupabaseStatus | null> => {
  try {
    const { stdout } = await runSupabase(
      ["status", "-o", "json"],
      STOP_TIMEOUT_MS
    )
    return JSON.parse(stdout) as SupabaseStatus
  } catch {
    return null
  }
}

const warmUpRealtime = async (url: string, anonKey: string): Promise<void> => {
  const client = createClient(url, anonKey)
  let received = false

  // supabase-js insert resolves with { error } instead of throwing, so failed
  // pokes (e.g. a leftover sentinel) are simply retried on the next attempt.
  const poke = async (): Promise<void> => {
    for (let attempt = 0; attempt < WARMUP_ATTEMPTS && !received; attempt++) {
      await client.from("users").insert({
        id: WARMUP_SENTINEL_ID + attempt,
        name: "warmup",
        email: `warmup-${attempt}@e2e.local`,
        active: true,
      })
      await delay(WARMUP_POKE_INTERVAL_MS)
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Realtime warm-up timed out; is the realtime container healthy?"
            )
          ),
        WARMUP_TIMEOUT_MS
      )
      client
        .channel("e2e-warmup")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "users" },
          () => {
            received = true
            clearTimeout(timer)
            resolve()
          }
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            poke().catch(() => undefined)
          }
        })
    })
  } finally {
    await client.removeAllChannels()
    await client.from("users").delete().gte("id", WARMUP_SENTINEL_ID)
  }
}

export default async function setup({ provide }: TestProject) {
  let startedByUs = false
  let url = process.env.SUPABASE_URL
  let anonKey = process.env.SUPABASE_ANON_KEY
  let serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Only touch Docker when creds were not already supplied by the environment.
  if (!(url && anonKey && serviceRoleKey)) {
    let status = await readStatus()

    if (!status) {
      // Boots only the containers the adapter needs (db, kong, rest, realtime);
      // every other service is disabled in supabase/config.toml.
      await runSupabase(["start"], START_TIMEOUT_MS)
      startedByUs = true
      status = await readStatus()
    }

    if (!(status?.API_URL && status.ANON_KEY && status.SERVICE_ROLE_KEY)) {
      throw new Error(
        "Could not resolve local Supabase credentials. Is Docker running? Try `pnpm exec supabase start`."
      )
    }

    url = status.API_URL
    anonKey = status.ANON_KEY
    serviceRoleKey = status.SERVICE_ROLE_KEY
  }

  // Confirm realtime is actually delivering before tests rely on it.
  await warmUpRealtime(url, anonKey)

  provide("supabaseUrl", url)
  provide("supabaseAnonKey", anonKey)
  provide("supabaseServiceRoleKey", serviceRoleKey)

  return async () => {
    // Only stop the stack if this setup started it; never tear down a stack the
    // developer (or CI) started separately.
    if (startedByUs) {
      await runSupabase(["stop"], STOP_TIMEOUT_MS)
    }
  }
}
