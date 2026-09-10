import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type BaseQueryBuilder,
  type ExtractContext,
  type InferResultType,
  type InitialQueryBuilder,
  Query,
  type QueryBuilder,
  queryOnce as queryOnceBase,
} from "@tanstack/db"
import { queryIrToSearch } from "./postgrest-filters"
import { postgrestRequest } from "./postgrest-request"
import {
  type SerializedExpression,
  type SerializedQueryIR,
  type SerializedSelect,
  serializeQueryIR,
} from "./serialize"

// ── Execution ───────────────────────────────────────────────────────

/**
 * Execute a SerializedQueryIR against Supabase and return the results.
 *
 * Produces a single PostgREST request using resource embedding for joins
 * and aggregate syntax for count/sum/avg/min/max.
 */
export async function executeQuery(
  supabase: SupabaseClient,
  ir: SerializedQueryIR
): Promise<unknown[]> {
  const { tableName, search } = queryIrToSearch(ir)
  const data = await postgrestRequest(supabase, tableName, {
    method: "GET",
    search,
  })
  return data ?? []
}

// ── Aggregate detection ─────────────────────────────────────────────

/** Check if a SerializedSelect contains any aggregate expressions */
function hasAggregates(select: SerializedSelect | undefined): boolean {
  if (!select) return false
  for (const value of Object.values(select)) {
    if (value && typeof value === "object" && "type" in value) {
      if ((value as SerializedExpression).type === "agg") return true
    }
  }
  return false
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Execute a TanStack DB query against Supabase in a one-shot manner.
 *
 * Translates the query IR to a single PostgREST request, pushing filters,
 * ordering, limit, offset, joins (resource embedding), and aggregates
 * to the server.
 *
 * Operations that cannot be pushed (groupBy, having, distinct, computed
 * select expressions) are not applied — the raw fetched data is returned
 * for client-side processing.
 */
export const queryOnce = <
  TQueryFn extends (q: InitialQueryBuilder) => QueryBuilder<any>,
  TQuery extends QueryBuilder<any> = ReturnType<TQueryFn>,
>(
  callback: TQueryFn,
  supabase: SupabaseClient
): Promise<InferResultType<ExtractContext<TQuery>>> => {
  const q = new Query()
  const ir = (callback(q) as unknown as BaseQueryBuilder)._getQuery()
  const serialized = serializeQueryIR(ir)
  if (
    hasAggregates(serialized.select) ||
    (serialized.groupBy?.length ?? 0) > 0 ||
    (serialized.having?.length ?? 0) > 0
  ) {
    return executeQuery(supabase, serialized) as Promise<
      InferResultType<ExtractContext<TQuery>>
    >
  }
  return queryOnceBase(callback as any) as Promise<
    InferResultType<ExtractContext<TQuery>>
  >
}
