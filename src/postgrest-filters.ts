import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
import type { SerializedExpression as Expression } from "./serialize"

type SupabaseQuery = PostgrestFilterBuilder<any, any, any, any>

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
    const inner = renderComparison(left, quoteScalars, options)
    if (!inner) return null
    return {
      ...inner,
      operator: inner.operator.startsWith("not.")
        ? inner.operator.slice(4)
        : `not.${inner.operator}`,
    }
  }
  if (left?.type !== "ref" || left.path[0] === "$selected") return null
  const column = (options.stripAlias ? left.path.slice(1) : left.path).join(".")
  if (!column) return null
  if (expr.name === "isNull") return { column, operator: "is", value: "null" }
  if (right?.type !== "val") return null

  if (expr.name === "in") {
    if (!Array.isArray(right.value)) return null
    return {
      column,
      operator: "in",
      value: `(${Array.from(new Set(right.value)).map(quoteValue).join(",")})`,
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
  options: FilterOptions
): string | null {
  if (expr.type !== "func") return null
  if (expr.name === "and" || expr.name === "or") {
    if (expr.args.length === 0) return null
    const parts = expr.args.map((arg) => toFilterString(arg, options))
    return parts.includes(null) ? null : `${expr.name}(${parts.join(",")})`
  }
  if (expr.name === "not") {
    const [inner] = expr.args
    if (inner?.type === "func") {
      if (inner.name === "not" && inner.args[0]) {
        return toFilterString(inner.args[0], options)
      }
      if (inner.name === "and" || inner.name === "or") {
        const filter = toFilterString(inner, options)
        return filter === null ? null : `not.${filter}`
      }
    }
  }
  const comparison = renderComparison(expr, true, options)
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
          filter:
            filter.type === "func" && filter.name === "or"
              ? embedded.slice(3, -1)
              : embedded,
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

export function applyPostgrestParams(
  query: SupabaseQuery,
  params: PostgrestParam[]
): SupabaseQuery {
  for (const param of params) {
    query =
      param.kind === "column"
        ? query.filter(param.column, param.operator, param.value)
        : query.or(param.filter)
  }
  return query
}

export function paramsToKey(params: PostgrestParam[]): string {
  const search = new URLSearchParams()
  for (const param of params) {
    if (param.kind === "column")
      search.append(param.column, `${param.operator}.${param.value}`)
    else search.append("or", `(${param.filter})`)
  }
  return search.toString()
}
