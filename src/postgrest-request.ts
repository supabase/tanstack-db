/* biome-ignore-all lint/suspicious/noExplicitAny: PostgrestFilterBuilder's generics require database schema types unavailable without codegen; they are irrelevant here since we only read `data`/`error` off the awaited response */
import { PostgrestFilterBuilder } from "@supabase/postgrest-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import { CLIENT_INFO, CLIENT_INFO_HEADER } from "./request-headers"

const SINGLE_ROW_ACCEPT = "application/vnd.pgrst.object+json"

interface PostgrestRequestOptions {
  /** JSON body for insert/update. */
  body?: unknown
  method: "GET" | "POST" | "PATCH" | "DELETE"
  /** Ask PostgREST to return the affected rows (`Prefer: return=representation`). */
  returnRows?: boolean
  /** The full query string, built by the params helpers. */
  search: URLSearchParams
  /** Expect exactly one row (`Accept: application/vnd.pgrst.object+json`). */
  single?: boolean
}

/**
 * Issue a PostgREST request with a hand-built query string while leaving
 * supabase-js in charge of auth, schema, tracing, timeout, and transport.
 *
 * `supabase.from(table)` yields a `PostgrestQueryBuilder` whose `url`,
 * `headers`, `schema`, and `fetch` are the auth-injecting, timeout-wrapped
 * request state (the `fetch` wrapper derives `apikey`/`Authorization`, the
 * headers already carry the user's `global.headers`). We clone that state,
 * swap in our own search string, and hand it to `PostgrestFilterBuilder` — a
 * documented standalone entry point — so we reuse its `Accept-Profile`/
 * `Content-Profile`, response parsing, and error handling without re-deriving
 * auth ourselves.
 */
export async function postgrestRequest(
  supabase: SupabaseClient,
  table: string,
  { method, search, body, returnRows, single }: PostgrestRequestOptions
): Promise<any> {
  const queryBuilder = supabase.from(table)

  const url = new URL(queryBuilder.url.toString())
  url.search = search.toString()

  const headers = new Headers(queryBuilder.headers)
  headers.set(CLIENT_INFO_HEADER, CLIENT_INFO)
  if (returnRows) {
    headers.append("Prefer", "return=representation")
  }
  if (single) {
    headers.set("Accept", SINGLE_ROW_ACCEPT)
  }

  const builder = new PostgrestFilterBuilder<any, any, any, any>({
    method,
    url,
    headers,
    schema: queryBuilder.schema,
    body,
    fetch: queryBuilder.fetch,
  })

  const { data, error } = await builder
  if (error) {
    throw error
  }
  return data
}
