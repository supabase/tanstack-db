import {
  extractSimpleComparisons,
  type LoadSubsetOptions,
  parseOrderByExpression,
  type SimpleComparison,
} from "@tanstack/db"
import type {
  SerializedExpression as Expression,
  SerializedFrom,
  SerializedJoinClause,
  SerializedQueryIR,
  SerializedSelect,
  SerializedWhere,
} from "./serialize"

type Comparison = { column: string; operator: string; value: string }
export type PostgrestParam =
  | ({ kind: "column" } & Comparison)
  | { kind: "group"; filter: string }

interface FilterOptions {
  mergeIn?: boolean
  strict?: boolean
  stripAlias?: boolean
}

// Only lists and logical groups parse quoted values. Top-level scalar values
// must remain raw: col=eq."x" would match the quotes themselves.
const NEEDS_QUOTES = /^$|^\s|\s$|[,()"\\]/
const quoteValue = (value: unknown): string => {
  const raw = `${value}`
  return NEEDS_QUOTES.test(raw)
    ? `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : raw
}

const SCALAR_OPERATORS = ["eq", "gt", "gte", "lt", "lte", "like", "ilike"]

function renderComparison(
  expr: Expression,
  quoteScalars: boolean,
  options: FilterOptions
): Comparison | null {
  if (expr.type !== "func") return null
  const [left, right] = expr.args
  if (expr.name === "not" && left) {
    if (left.type === "func" && left.name === "not" && left.args[0]) {
      return renderComparison(left.args[0], quoteScalars, options)
    }
    const inner = renderComparison(left, quoteScalars, options)
    if (!inner) return null
    // TanStack's NOT IN [] excludes nulls; PostgREST's NOT IN () includes them.
    if (inner.operator === "in" && inner.value === "()") {
      return { ...inner, operator: "not.is", value: "null" }
    }
    return {
      ...inner,
      operator: `not.${inner.operator}`,
    }
  }
  if (left?.type !== "ref" || left.path[0] === "$selected") return null
  const column = (options.stripAlias ? left.path.slice(1) : left.path).join(".")
  if (!column) return null
  if (expr.name === "isNull") return { column, operator: "is", value: "null" }
  if (right?.type !== "val") return null

  if (expr.name === "in") {
    if (!Array.isArray(right.value)) return null
    // TanStack's membership test ignores null list members for non-null rows.
    const values = Array.from(
      new Set(right.value.filter((value) => value != null))
    )
    // PostgREST treats IN ("") as an empty list, even when quoted.
    if (values.length === 1 && values[0] === "") {
      return { column, operator: "eq", value: quoteScalars ? '""' : "" }
    }
    return {
      column,
      operator: "in",
      value: `(${values.map(quoteValue).join(",")})`,
    }
  }
  if (!SCALAR_OPERATORS.includes(expr.name)) return null
  let value = right.value
  if (expr.name === "like" || expr.name === "ilike") {
    // TanStack uses SQL %/_ wildcards, but treats * and backslashes literally.
    // PostgREST always rewrites * to %, so such patterns cannot be pushed.
    if (typeof value !== "string" || value.includes("*")) return null
    value = value.replace(/\\/g, "\\\\")
  }
  return {
    column,
    operator: expr.name,
    value: quoteScalars ? quoteValue(value) : `${value}`,
  }
}

// Embedded expressions are all-or-nothing. Dropping a child of OR or NOT
// could narrow the response and permanently lose matching rows.
function toFilterString(
  expr: Expression,
  options: FilterOptions,
  negated = false
): string | null {
  if (expr.type !== "func") return null
  if (expr.name === "not") {
    return expr.args[0] ? toFilterString(expr.args[0], options, !negated) : null
  }
  if (expr.name === "and" || expr.name === "or") {
    if (expr.args.length === 0) return null
    // Move NOT down to comparisons with De Morgan's laws. In particular, an
    // empty IN list needs its null guard even under a negated logical group.
    const operator = negated ? (expr.name === "and" ? "or" : "and") : expr.name
    const parts = expr.args.map((arg) => toFilterString(arg, options, negated))
    return parts.includes(null) ? null : `${operator}(${parts.join(",")})`
  }
  const comparison = renderComparison(
    negated ? { type: "func", name: "not", args: [expr] } : expr,
    true,
    options
  )
  return comparison
    ? `${comparison.column}.${comparison.operator}.${comparison.value}`
    : null
}

function flattenAnd(expr: Expression): Expression[] {
  return expr.type === "func" && expr.name === "and"
    ? expr.args.flatMap(flattenAnd)
    : [expr]
}

// Preserve the live adapter's union of duplicate IN demands. This deliberately
// fetches a superset, which TanStack re-filters. Never do this inside OR/NOT or
// for server aggregates, where client-side filtering cannot repair the result.
function mergeInFilters(filters: Expression[]): Expression[] {
  const merged: Expression[] = []
  const valuesByField = new Map<string, unknown[]>()
  for (const filter of filters) {
    if (filter.type !== "func" || filter.name !== "in") {
      merged.push(filter)
      continue
    }
    const [left, right] = filter.args
    if (
      left?.type !== "ref" ||
      right?.type !== "val" ||
      !Array.isArray(right.value)
    ) {
      merged.push(filter)
      continue
    }
    const field = JSON.stringify(left.path)
    const existing = valuesByField.get(field)
    if (existing) {
      existing.push(...right.value)
    } else {
      const values = [...right.value]
      valuesByField.set(field, values)
      merged.push({ ...filter, args: [left, { type: "val", value: values }] })
    }
  }
  return merged
}

export function toPostgrestParams(
  expr: Expression | undefined | null,
  options: FilterOptions = {}
): PostgrestParam[] {
  if (!expr) return []
  const conjuncts = flattenAnd(expr)
  const filters = options.mergeIn ? mergeInFilters(conjuncts) : conjuncts
  return filters.flatMap((filter): PostgrestParam[] => {
    const comparison = renderComparison(filter, false, options)
    if (comparison) return [{ kind: "column", ...comparison }]
    const embedded = toFilterString(filter, options)
    if (embedded !== null) {
      return [
        {
          kind: "group",
          filter: embedded.startsWith("or(") ? embedded.slice(3, -1) : embedded,
        },
      ]
    }
    if (options.strict) {
      throw new Error(
        "Cannot push WHERE expression to PostgREST; server aggregates require fully pushable filters"
      )
    }
    return []
  })
}

/** Render params as the `URLSearchParams` sent to (and keyed by) PostgREST. */
export function paramsToSearch(params: PostgrestParam[]): URLSearchParams {
  const search = new URLSearchParams()
  for (const param of params) {
    if (param.kind === "column")
      search.append(param.column, `${param.operator}.${param.value}`)
    else search.append("or", `(${param.filter})`)
  }
  return search
}

export function paramsToKey(params: PostgrestParam[]): string {
  return paramsToSearch(params).toString()
}

// Cursor operators arrive pre-flattened as `SimpleComparison`. Scalar values
// are emitted raw (top-level params must not be quoted); only IN members quote.
const CURSOR_SCALAR_OPERATORS: Record<string, string> = {
  eq: "eq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  not_eq: "not.eq",
}

/** Convert pre-flattened cursor comparisons to PostgREST params. */
export function cursorToPostgrestParams(
  filters: SimpleComparison[]
): PostgrestParam[] {
  return filters.flatMap((filter): PostgrestParam[] => {
    const column = filter.field.join(".")
    if (filter.operator === "in") {
      const values = Array.isArray(filter.value) ? filter.value : []
      return [
        {
          kind: "column",
          column,
          operator: "in",
          value: `(${values.map(quoteValue).join(",")})`,
        },
      ]
    }
    if (filter.operator === "isNull") {
      return [{ kind: "column", column, operator: "is", value: "null" }]
    }
    const operator = CURSOR_SCALAR_OPERATORS[filter.operator]
    if (!operator) {
      console.warn(
        `cursorToPostgrestParams: unsupported operator: ${filter.operator}`
      )
      return []
    }
    return [{ kind: "column", column, operator, value: `${filter.value}` }]
  })
}

/** Set the comma-joined `order` param (independent of limit/offset). */
export function appendOrder(
  search: URLSearchParams,
  sorts: Array<{ column: string; ascending: boolean }>
): void {
  if (sorts.length === 0) return
  search.set(
    "order",
    sorts
      .map((sort) => `${sort.column}.${sort.ascending ? "asc" : "desc"}`)
      .join(",")
  )
}

export function appendLimit(search: URLSearchParams, limit: number): void {
  search.set("limit", `${limit}`)
}

export function appendOffset(search: URLSearchParams, offset: number): void {
  search.set("offset", `${offset}`)
}

/**
 * Encode the params that identify a cached subset — where filters, order, and
 * limit. Deliberately excludes `select`, `cursor`, and `offset`: those are the
 * per-page request details, not part of what distinguishes one subset from
 * another. This is the shared core of the request URL and the query key, so the
 * two cannot drift.
 */
export function subsetParamsToSearch(
  options: LoadSubsetOptions
): URLSearchParams {
  const { where, orderBy, limit } = options
  const search = paramsToSearch(toPostgrestParams(where, { mergeIn: true }))
  appendOrder(
    search,
    parseOrderByExpression(orderBy).map((sort) => ({
      column: sort.field.join("."),
      ascending: sort.direction === "asc",
    }))
  )
  if (limit) {
    appendLimit(search, limit)
  }
  return search
}

/**
 * Build the full read query string for a TanStack DB subset load: the shared
 * subset params ({@link subsetParamsToSearch}) plus `select=*`, cursor filters,
 * and offset.
 */
export function loadSubsetOptionsToSearch(
  options: LoadSubsetOptions
): URLSearchParams {
  const search = new URLSearchParams()
  search.set("select", "*")
  for (const [key, value] of subsetParamsToSearch(options)) {
    search.append(key, value)
  }

  const cursorFilters = options.cursor
    ? [...extractSimpleComparisons(options.cursor.whereFrom)]
    : []
  for (const [key, value] of paramsToSearch(
    cursorToPostgrestParams(cursorFilters)
  )) {
    search.append(key, value)
  }

  if (options.offset) {
    appendOffset(search, options.offset)
  }
  return search
}

/** Build the `key.eq.value` search that matches one row by its key columns. */
export function keyColumnsToSearch(
  keys: string[],
  item: Record<string, unknown>
): URLSearchParams {
  return paramsToSearch(
    keys.map((key) => ({
      kind: "column",
      column: key,
      operator: "eq",
      value: `${item[key]}`,
    }))
  )
}

// ── Serialized query IR → search ────────────────────────────────────

/** Extract column name from a ref expression (drops the table alias prefix) */
function refToColumn(expr: Expression): string {
  if (expr.type !== "ref") {
    throw new Error(`Expected ref expression, got ${expr.type}`)
  }
  return expr.path.slice(1).join(".")
}

/** Unwrap a SerializedWhere to its expression */
function getExpression(where: SerializedWhere): Expression {
  if ("type" in where) return where as Expression
  return (where as { expression: Expression }).expression
}

/** Check if a where clause is residual (client-side only, cannot be pushed to PostgREST) */
function isResidual(where: SerializedWhere): boolean {
  if ("type" in where) return false
  return (where as { residual?: boolean }).residual === true
}

/** Check if a ref expression points to a computed/selected field */
function isComputedRef(expr: Expression): boolean {
  return expr.type === "ref" && expr.path[0] === "$selected"
}

/** Resolve a FROM clause to a base table name, collecting where clauses from subqueries */
function resolveFrom(from: SerializedFrom): {
  tableName: string
  wheres: SerializedWhere[]
} {
  if (from.type === "table") {
    return { tableName: from.name, wheres: [] }
  }
  if (from.type === "subquery") {
    const inner = resolveFrom(from.query.from)
    return {
      tableName: inner.tableName,
      wheres: [...inner.wheres, ...(from.query.where ?? [])],
    }
  }
  // union / unionAll have no single base table to push to PostgREST
  throw new Error(
    `Cannot push a ${from.type} query to PostgREST; unions are not supported in queryOnce`
  )
}

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

  return stripSelectWhitespace(parts.join(", "))
}

/**
 * Remove whitespace outside of quoted segments, mirroring postgrest-js's
 * `.select()`. We build the select with `", "` separators for readability but
 * PostgREST expects a compact list.
 */
function stripSelectWhitespace(select: string): string {
  let quoted = false
  let result = ""
  for (const char of select) {
    if (/\s/.test(char) && !quoted) continue
    if (char === '"') quoted = !quoted
    result += char
  }
  return result
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
      const part = exprToSelectPart(alias, value as Expression)
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
function exprToSelectPart(alias: string, expr: Expression): string | null {
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
function aggToSelectPart(alias: string, expr: Expression): string | null {
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

/**
 * Build the PostgREST query string (and resolve the base table) from a
 * SerializedQueryIR.
 *
 * Pushes to PostgREST:
 * - **select**: column refs, aggregates (count/sum/avg/min/max)
 * - **joins**: resource embedding with `!inner` / `!left` hints
 * - **where**: eq, gt, gte, lt, lte, like, ilike, isNull, in, not, and, or
 * - **orderBy**: real column refs (skips computed/$selected)
 * - **limit / offset**
 *
 * Falls back to `select=*` when:
 * - select contains non-pushable expressions (func, computed refs)
 * - groupBy is present (aggregation done client-side)
 */
export function queryIrToSearch(ir: SerializedQueryIR): {
  tableName: string
  search: URLSearchParams
} {
  const { tableName, wheres: subqueryWheres } = resolveFrom(ir.from)
  const allWheres = [...subqueryWheres, ...(ir.where ?? [])]

  const search = new URLSearchParams()
  search.set("select", buildSelectString(ir))

  // Apply pushable where filters (skip residual / client-side filters)
  for (const w of allWheres) {
    if (isResidual(w)) continue
    const filters = paramsToSearch(
      toPostgrestParams(getExpression(w), { stripAlias: true, strict: true })
    )
    for (const [key, value] of filters) {
      search.append(key, value)
    }
  }

  // Apply order by (only real column refs, skip computed/$selected refs)
  const sorts: Array<{ column: string; ascending: boolean }> = []
  for (const ob of ir.orderBy ?? []) {
    if (ob.expression.type === "ref" && !isComputedRef(ob.expression)) {
      sorts.push({
        column: refToColumn(ob.expression),
        ascending: ob.direction === "asc",
      })
    }
  }
  appendOrder(search, sorts)

  // limit and offset are independent params — no derived range
  if (ir.limit !== undefined) {
    appendLimit(search, ir.limit)
  }
  if (ir.offset !== undefined) {
    appendOffset(search, ir.offset)
  }

  return { tableName, search }
}
