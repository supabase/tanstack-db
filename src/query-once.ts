import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
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
import {
  type SerializedExpression,
  type SerializedFrom,
  type SerializedJoinClause,
  type SerializedQueryIR,
  type SerializedSelect,
  type SerializedWhere,
  serializeQueryIR,
} from "./serialize"

type SupabaseQuery = PostgrestFilterBuilder<any, any, any, any, any, any, any>

// ── Expression helpers ──────────────────────────────────────────────

/** Extract column name from a ref expression (drops the table alias prefix) */
function refToColumn(expr: SerializedExpression): string {
  if (expr.type !== "ref") {
    throw new Error(`Expected ref expression, got ${expr.type}`)
  }
  return expr.path.slice(1).join(".")
}

/** Extract literal value from a val expression */
function extractValue(expr: SerializedExpression): unknown {
  if (expr.type !== "val") {
    throw new Error(`Expected val expression, got ${expr.type}`)
  }
  return expr.value
}

/** Unwrap a SerializedWhere to its expression */
function getExpression(where: SerializedWhere): SerializedExpression {
  if ("type" in where) return where as SerializedExpression
  return (where as { expression: SerializedExpression }).expression
}

/** Check if a where clause is residual (client-side only, cannot be pushed to PostgREST) */
function isResidual(where: SerializedWhere): boolean {
  if ("type" in where) return false
  return (where as { residual?: boolean }).residual === true
}

/** Check if a ref expression points to a computed/selected field */
function isComputedRef(expr: SerializedExpression): boolean {
  return expr.type === "ref" && expr.path[0] === "$selected"
}

// ── FROM resolution ─────────────────────────────────────────────────

/** Resolve a FROM clause to a base table name, collecting where clauses from subqueries */
function resolveFrom(from: SerializedFrom): {
  tableName: string
  wheres: SerializedWhere[]
} {
  if (from.type === "table") {
    return { tableName: from.name, wheres: [] }
  }
  const inner = resolveFrom(from.query.from)
  return {
    tableName: inner.tableName,
    wheres: [...inner.wheres, ...(from.query.where ?? [])],
  }
}

// ── Select string building ──────────────────────────────────────────

interface EmbedNode {
  alias: string
  children: EmbedNode[]
  hint: string
  joinType: string
  tableName: string
}

/**
 * Build the PostgREST select string from the IR.
 *
 * Handles:
 * - Column refs: `alias:column` or just `column`
 * - Aggregates: `alias:column.count()`, `alias:column.sum()`, etc.
 * - Join embeddings: `table!fk!inner(*)`, `table!fk(*)`
 *
 * Falls back to `*` when select contains non-pushable expressions
 * (func, computed refs, groupBy present).
 */
function buildSelectString(ir: SerializedQueryIR): string {
  const parts: string[] = []
  let hasExplicitColumns = false

  // Process select fields (aggregates and column refs)
  // Skip pushing select when groupBy is present (aggregation done client-side)
  if (ir.select && !ir.groupBy?.length) {
    const selectParts = processSelectEntries(ir.select)
    if (selectParts !== null) {
      parts.push(...selectParts)
      hasExplicitColumns = true
    }
  }

  if (!hasExplicitColumns) {
    parts.push("*")
  }

  // Add join resource embeddings
  if (ir.join?.length) {
    const embedStrings = buildJoinEmbeds(ir)
    parts.push(...embedStrings)
  }

  return parts.join(", ")
}

/**
 * Convert a SerializedSelect map into PostgREST select parts.
 * Returns null if any entry cannot be pushed (signals fallback to `*`).
 */
function processSelectEntries(select: SerializedSelect): string[] | null {
  const parts: string[] = []

  for (const [alias, value] of Object.entries(select)) {
    // A spread (`...row`) can't be expressed as a fixed column list
    if (alias.startsWith("__SPREAD_SENTINEL__")) return null
    if (value && typeof value === "object" && "type" in value) {
      const part = exprToSelectPart(alias, value as SerializedExpression)
      if (part === null) return null
      parts.push(part)
    } else {
      // Nested select object — can't push to PostgREST
      return null
    }
  }

  return parts.length > 0 ? parts : null
}

/** Convert a single select expression to a PostgREST select part */
function exprToSelectPart(
  alias: string,
  expr: SerializedExpression
): string | null {
  if (expr.type === "ref") {
    if (isComputedRef(expr)) return null
    const column = refToColumn(expr)
    return alias === column ? column : `${alias}:${column}`
  }
  if (expr.type === "agg") {
    return aggToSelectPart(alias, expr)
  }
  // func, val, includesSubquery — can't push
  return null
}

/**
 * Convert an aggregate expression to PostgREST select syntax.
 *
 * - `count(column)` → `alias:column.count()`
 * - `sum(column)`   → `alias:column.sum()`
 * - `avg(column)`   → `alias:column.avg()`
 * - `min(column)`   → `alias:column.min()`
 * - `max(column)`   → `alias:column.max()`
 */
function aggToSelectPart(
  alias: string,
  expr: SerializedExpression
): string | null {
  if (expr.type !== "agg") return null

  const { name, args } = expr

  if (
    name === "count" ||
    name === "sum" ||
    name === "avg" ||
    name === "min" ||
    name === "max"
  ) {
    if (args.length > 0 && args[0].type === "ref") {
      const column = refToColumn(args[0])
      return `${alias}:${column}.${name}()`
    }
    if (name === "count") {
      return `${alias}:count`
    }
    return null
  }

  return null
}

// ── Join embedding ──────────────────────────────────────────────────

/**
 * Build PostgREST resource embedding strings for joins.
 *
 * Constructs a tree of embed nodes to handle chained joins (e.g.,
 * `users JOIN users_todos JOIN todos` → nested embedding).
 *
 * Join type mapping:
 * - `inner` → `!inner`
 * - `left`  → (default, no hint needed)
 * - `right` → `!inner` (semantically: right table always present)
 * - `full`  → (default left embedding — partial semantics)
 */
function buildJoinEmbeds(ir: SerializedQueryIR): string[] {
  if (!ir.join?.length) return []

  const fromAlias = ir.from.type === "table" ? ir.from.alias : ir.from.alias

  // Build a tree: root is the FROM table, children are embedded joins
  const root: EmbedNode = {
    tableName: resolveFrom(ir.from).tableName,
    alias: fromAlias,
    hint: "",
    joinType: "",
    children: [],
  }

  const nodeMap = new Map<string, EmbedNode>()
  nodeMap.set(fromAlias, root)

  for (const join of ir.join) {
    const { tableName: joinTable } = resolveFrom(join.from)
    const joinAlias =
      join.from.type === "table" ? join.from.alias : join.from.alias

    const { parentAlias, fkHint } = resolveJoinParent(join, joinAlias, nodeMap)

    const node: EmbedNode = {
      tableName: joinTable,
      alias: joinAlias,
      hint: fkHint,
      joinType: join.type,
      children: [],
    }

    const parent = nodeMap.get(parentAlias) ?? root
    parent.children.push(node)
    nodeMap.set(joinAlias, node)
  }

  return root.children.map(renderEmbedNode)
}

/**
 * Determine which existing node a join attaches to, and extract
 * the foreign key hint from the join condition.
 */
function resolveJoinParent(
  join: SerializedJoinClause,
  joinAlias: string,
  nodeMap: Map<string, EmbedNode>
): { parentAlias: string; fkHint: string } {
  const leftAlias = join.left.type === "ref" ? join.left.path[0] : null
  const rightAlias = join.right.type === "ref" ? join.right.path[0] : null

  // Left side is existing table, right side is the new join table
  if (leftAlias && nodeMap.has(leftAlias) && rightAlias === joinAlias) {
    const fk =
      join.right.type === "ref" ? join.right.path.slice(1).join(".") : ""
    return { parentAlias: leftAlias, fkHint: fk }
  }

  // Right side is existing table, left side is the new join table
  if (rightAlias && nodeMap.has(rightAlias) && leftAlias === joinAlias) {
    const fk = join.left.type === "ref" ? join.left.path.slice(1).join(".") : ""
    return { parentAlias: rightAlias, fkHint: fk }
  }

  // Fallback: attach to whichever side is already in the tree
  if (leftAlias && nodeMap.has(leftAlias)) {
    const fk =
      join.right.type === "ref" ? join.right.path.slice(1).join(".") : ""
    return { parentAlias: leftAlias, fkHint: fk }
  }
  if (rightAlias && nodeMap.has(rightAlias)) {
    const fk = join.left.type === "ref" ? join.left.path.slice(1).join(".") : ""
    return { parentAlias: rightAlias, fkHint: fk }
  }

  return { parentAlias: "", fkHint: "" }
}

/** Render an embed node as a PostgREST resource embedding string */
function renderEmbedNode(node: EmbedNode): string {
  const hintStr = node.hint ? `!${node.hint}` : ""
  const typeStr =
    node.joinType === "inner" || node.joinType === "right" ? "!inner" : ""

  const innerParts = ["*"]
  for (const child of node.children) {
    innerParts.push(renderEmbedNode(child))
  }

  return `${node.tableName}${hintStr}${typeStr}(${innerParts.join(", ")})`
}

// ── Filter string conversion (for .or() and .not()) ────────────────

/** Convert a comparison expression to a PostgREST filter string */
function toFilterString(expr: SerializedExpression): string {
  if (expr.type !== "func") {
    throw new Error(`Expected func expression, got ${expr.type}`)
  }

  switch (expr.name) {
    case "eq":
      return `${refToColumn(expr.args[0])}.eq.${extractValue(expr.args[1])}`
    case "neq":
      return `${refToColumn(expr.args[0])}.neq.${extractValue(expr.args[1])}`
    case "gt":
      return `${refToColumn(expr.args[0])}.gt.${extractValue(expr.args[1])}`
    case "gte":
      return `${refToColumn(expr.args[0])}.gte.${extractValue(expr.args[1])}`
    case "lt":
      return `${refToColumn(expr.args[0])}.lt.${extractValue(expr.args[1])}`
    case "lte":
      return `${refToColumn(expr.args[0])}.lte.${extractValue(expr.args[1])}`
    case "isNull":
      return `${refToColumn(expr.args[0])}.is.null`
    case "inArray": {
      const values = extractValue(expr.args[1]) as unknown[]
      return `${refToColumn(expr.args[0])}.in.(${values.join(",")})`
    }
    case "not":
      return toNotFilterString(expr.args[0])
    case "and":
      return `and(${expr.args.map(toFilterString).join(",")})`
    case "or":
      return `or(${expr.args.map(toFilterString).join(",")})`
    default:
      throw new Error(`Unsupported operator in filter string: ${expr.name}`)
  }
}

/** Convert the inner expression of a NOT to a negated PostgREST filter string */
function toNotFilterString(expr: SerializedExpression): string {
  if (expr.type !== "func") {
    throw new Error(`Expected func inside not, got ${expr.type}`)
  }
  switch (expr.name) {
    case "eq":
      return `${refToColumn(expr.args[0])}.not.eq.${extractValue(expr.args[1])}`
    case "neq":
      return `${refToColumn(expr.args[0])}.not.neq.${extractValue(expr.args[1])}`
    case "gt":
      return `${refToColumn(expr.args[0])}.not.gt.${extractValue(expr.args[1])}`
    case "gte":
      return `${refToColumn(expr.args[0])}.not.gte.${extractValue(expr.args[1])}`
    case "lt":
      return `${refToColumn(expr.args[0])}.not.lt.${extractValue(expr.args[1])}`
    case "lte":
      return `${refToColumn(expr.args[0])}.not.lte.${extractValue(expr.args[1])}`
    case "isNull":
      return `${refToColumn(expr.args[0])}.not.is.null`
    case "inArray": {
      const values = extractValue(expr.args[1]) as unknown[]
      return `${refToColumn(expr.args[0])}.not.in.(${values.join(",")})`
    }
    default:
      return `${refToColumn(expr.args[0])}.not.${expr.name}.${extractValue(expr.args[1])}`
  }
}

// ── Filter application ──────────────────────────────────────────────

/** Apply a single where expression to a Supabase query builder */
function applyFilter(
  query: SupabaseQuery,
  expr: SerializedExpression
): SupabaseQuery {
  if (expr.type !== "func") {
    console.warn(`Cannot push non-func expression to PostgREST: ${expr.type}`)
    return query
  }

  switch (expr.name) {
    case "eq":
      return query.eq(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "neq":
      return query.neq(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "gt":
      return query.gt(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "gte":
      return query.gte(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "lt":
      return query.lt(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "lte":
      return query.lte(refToColumn(expr.args[0]), extractValue(expr.args[1]))
    case "isNull":
      return query.is(refToColumn(expr.args[0]), null)
    case "inArray":
      return query.in(
        refToColumn(expr.args[0]),
        extractValue(expr.args[1]) as unknown[]
      )
    case "not":
      return applyNotFilter(query, expr.args[0])
    case "and":
      // AND is implicit in PostgREST — apply each filter sequentially
      for (const arg of expr.args) {
        query = applyFilter(query, arg)
      }
      return query
    case "or":
      return query.or(expr.args.map(toFilterString).join(","))
    default:
      console.warn(`Unsupported operator for PostgREST: ${expr.name}`)
      return query
  }
}

/** Apply a NOT(inner) filter to a Supabase query builder */
function applyNotFilter(
  query: SupabaseQuery,
  inner: SerializedExpression
): SupabaseQuery {
  if (inner.type !== "func") {
    console.warn(`Cannot push non-func inside not to PostgREST`)
    return query
  }
  switch (inner.name) {
    case "eq":
      return query.not(
        refToColumn(inner.args[0]),
        "eq",
        extractValue(inner.args[1]) as string
      )
    case "neq":
      return query.not(
        refToColumn(inner.args[0]),
        "neq",
        extractValue(inner.args[1]) as string
      )
    case "gt":
      return query.not(
        refToColumn(inner.args[0]),
        "gt",
        extractValue(inner.args[1]) as string
      )
    case "gte":
      return query.not(
        refToColumn(inner.args[0]),
        "gte",
        extractValue(inner.args[1]) as string
      )
    case "lt":
      return query.not(
        refToColumn(inner.args[0]),
        "lt",
        extractValue(inner.args[1]) as string
      )
    case "lte":
      return query.not(
        refToColumn(inner.args[0]),
        "lte",
        extractValue(inner.args[1]) as string
      )
    case "isNull":
      return query.not(refToColumn(inner.args[0]), "is", null as any)
    case "inArray": {
      const values = extractValue(inner.args[1]) as unknown[]
      return query.not(
        refToColumn(inner.args[0]),
        "in",
        `(${values.join(",")})` as any
      )
    }
    default:
      return query.not(
        refToColumn(inner.args[0]),
        inner.name as any,
        extractValue(inner.args[1]) as any
      )
  }
}

// ── Query building ──────────────────────────────────────────────────

/**
 * Build a Supabase query from a SerializedQueryIR.
 *
 * Pushes to PostgREST:
 * - **select**: column refs, aggregates (count/sum/avg/min/max)
 * - **joins**: resource embedding with `!inner` / `!left` hints
 * - **where**: eq, neq, gt, gte, lt, lte, isNull, inArray, not, and, or
 * - **orderBy**: real column refs (skips computed/$selected)
 * - **limit / offset**
 *
 * Falls back to `select=*` when:
 * - select contains non-pushable expressions (func, computed refs)
 * - groupBy is present (aggregation done client-side)
 */
export function buildSupabaseQuery(
  supabase: SupabaseClient,
  ir: SerializedQueryIR
): SupabaseQuery {
  const { tableName, wheres: subqueryWheres } = resolveFrom(ir.from)
  const allWheres = [...subqueryWheres, ...(ir.where ?? [])]

  const selectString = buildSelectString(ir)
  let query: SupabaseQuery = supabase.from(tableName).select(selectString)

  // Apply pushable where filters (skip residual / client-side filters)
  for (const w of allWheres) {
    if (isResidual(w)) continue
    query = applyFilter(query, getExpression(w))
  }

  // Apply order by (only real column refs, skip computed/$selected refs)
  for (const ob of ir.orderBy ?? []) {
    if (ob.expression.type === "ref" && !isComputedRef(ob.expression)) {
      query = query.order(refToColumn(ob.expression), {
        ascending: ob.direction === "asc",
      })
    }
  }

  // Apply limit
  if (ir.limit !== undefined) {
    query = query.limit(ir.limit)
  }

  // Apply offset via range
  if (ir.offset !== undefined) {
    const end = ir.offset + (ir.limit ?? 1000) - 1
    query = query.range(ir.offset, end)
  }

  return query
}

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
  const { data, error } = await buildSupabaseQuery(supabase, ir)
  if (error) throw error
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
