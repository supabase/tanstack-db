import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  type DeleteMutationFnParams,
  extractSimpleComparisons,
  type InsertMutationFnParams,
  type IR,
  type LoadSubsetOptions,
  parseOrderByExpression,
  type SimpleComparison,
  type UpdateMutationFnParams,
} from "@tanstack/db"
import type { QueryClient, QueryMeta } from "@tanstack/query-core"

type GenericPostgrestFilterBuilder = PostgrestFilterBuilder<any, any, any, any>

type Expression = IR.BasicExpression

/**
 * A pushed-down filter, as the PostgREST query parameter it becomes.
 *
 * A comparison is its own parameter, `column=operator.value`. Anything logical
 * rides inside `or=(…)`: a one-element disjunction *is* that element, so a
 * top-level `not.and(…)` reaches the server unchanged without having to
 * synthesise a parameter name the postgrest-js builder cannot append.
 */
type PostgrestParam =
  | { kind: "column"; column: string; operator: string; value: string }
  | { kind: "group"; filter: string }

type Comparison = { column: string; operator: string; value: string }

/**
 * PostgREST splits the parenthesised filter forms — `in.(…)`, `or=(…)` — on
 * commas and parens, so a value carrying one (a search term typed by a reader,
 * say) silently corrupts the filter around it unless it is quoted.
 *
 * Only those forms parse quotes. A top-level `col=eq."x"` matches the literal
 * `"x"`, quotes included — and needs no escaping anyway, since the value runs
 * to the end of the parameter and nothing can delimit it early.
 */
const NEEDS_QUOTES = /^$|^\s|\s$|[,()"\\]/

export const quoteValue = (value: unknown): string => {
  const raw = `${value}`
  if (!NEEDS_QUOTES.test(raw)) {
    return raw
  }
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

const SCALAR_OPERATORS = ["eq", "gt", "gte", "lt", "lte", "like", "ilike"]

/**
 * Render one comparison, or null when it is not a plain column-against-literal
 * test. `quoteScalars` picks between the two contexts above; a list is always
 * parenthesised, so its members are quoted either way.
 */
const renderComparison = (
  name: string,
  args: Array<Expression>,
  quoteScalars: boolean
): Comparison | null => {
  const [left, right] = args
  if (left?.type !== "ref") {
    return null
  }
  const column = left.path.join(".")

  if (name === "isNull") {
    return { column, operator: "is", value: "null" }
  }
  if (right?.type !== "val") {
    return null
  }

  // `inArray()` builds a func named `in`, not `inArray`.
  if (name === "in") {
    const values = Array.isArray(right.value) ? right.value : [right.value]
    const unique = Array.from(new Set(values))
    return {
      column,
      operator: "in",
      value: `(${unique.map(quoteValue).join(",")})`,
    }
  }

  if (!SCALAR_OPERATORS.includes(name)) {
    return null
  }
  return {
    column,
    operator: name,
    value: quoteScalars ? quoteValue(right.value) : `${right.value}`,
  }
}

/**
 * Render an expression as an embedded filter — the form that goes inside
 * `or(…)` / `and(…)`.
 *
 * Strict: null unless the whole subtree pushes. Dropping a disjunct would
 * *narrow* the result and lose matching rows, and under a `not` dropping a
 * conjunct does the same once the negation applies. Only the top level can
 * afford to drop anything, and `toPostgrestParams` is where that happens.
 */
const toFilterString = (expr: Expression): string | null => {
  if (expr.type !== "func") {
    return null
  }

  if (expr.name === "and" || expr.name === "or") {
    const parts = expr.args.map(toFilterString)
    if (parts.includes(null)) {
      return null
    }
    return `${expr.name}(${parts.join(",")})`
  }

  if (expr.name === "not") {
    const [inner] = expr.args
    if (inner?.type !== "func") {
      return null
    }
    if (inner.name === "and" || inner.name === "or") {
      const nested = toFilterString(inner)
      return nested === null ? null : `not.${nested}`
    }
    const negated = renderComparison(inner.name, inner.args, true)
    if (!negated) {
      return null
    }
    return `${negated.column}.not.${negated.operator}.${negated.value}`
  }

  const comparison = renderComparison(expr.name, expr.args, true)
  if (!comparison) {
    return null
  }
  return `${comparison.column}.${comparison.operator}.${comparison.value}`
}

/**
 * Split a WHERE expression into the PostgREST parameters it pushes down to.
 *
 * Top-level `and` conjuncts are independent parameters, so an unpushable one is
 * simply dropped: the request comes back a superset and the client re-filters
 * it. Everything below that point is all-or-nothing.
 *
 * The same walk feeds both the request and the query key, so the two cannot
 * disagree about what was pushed — two live queries share a cache entry only
 * when they issue the identical request.
 */
export const toPostgrestParams = (
  expr: Expression | undefined | null
): Array<PostgrestParam> => {
  if (!expr || expr.type !== "func") {
    return []
  }

  if (expr.name === "and") {
    return expr.args.flatMap(toPostgrestParams)
  }

  if (expr.name === "or") {
    const parts = expr.args.map(toFilterString)
    if (parts.includes(null)) {
      return []
    }
    return [{ kind: "group", filter: parts.join(",") }]
  }

  if (expr.name === "not") {
    const [inner] = expr.args
    const isLogical =
      inner?.type === "func" && (inner.name === "and" || inner.name === "or")
    const negated =
      inner?.type === "func" && !isLogical
        ? renderComparison(inner.name, inner.args, false)
        : null
    if (negated) {
      return [
        { kind: "column", ...negated, operator: `not.${negated.operator}` },
      ]
    }
    const filter = toFilterString(expr)
    return filter === null ? [] : [{ kind: "group", filter }]
  }

  const comparison = renderComparison(expr.name, expr.args, false)
  return comparison ? [{ kind: "column", ...comparison }] : []
}

const paramToString = (param: PostgrestParam): string =>
  param.kind === "column"
    ? `${param.column}=${param.operator}.${param.value}`
    : `or=(${param.filter})`

const applyParam = (
  baseQuery: GenericPostgrestFilterBuilder,
  param: PostgrestParam
): GenericPostgrestFilterBuilder =>
  param.kind === "column"
    ? baseQuery.filter(param.column, param.operator as any, param.value)
    : baseQuery.or(param.filter)

/** Cursor filters arrive pre-flattened as `SimpleComparison`, not as IR. */
const buildQuery = (
  baseQuery: GenericPostgrestFilterBuilder,
  filter: SimpleComparison
): GenericPostgrestFilterBuilder => {
  const field = filter.field.join(".")
  if (filter.operator === "eq") {
    return baseQuery.eq(field, filter.value)
  }
  if (filter.operator === "gt") {
    return baseQuery.gt(field, filter.value)
  }
  if (filter.operator === "gte") {
    return baseQuery.gte(field, filter.value)
  }
  if (filter.operator === "lt") {
    return baseQuery.lt(field, filter.value)
  }
  if (filter.operator === "lte") {
    return baseQuery.lte(field, filter.value)
  }
  if (filter.operator === "in") {
    return baseQuery.in(field, filter.value)
  }
  if (filter.operator === "isNull") {
    return baseQuery.is(field, null)
  }
  if (filter.operator === "not_eq") {
    return baseQuery.not(field, "eq", filter.value)
  }
  console.warn(`buildQuery: unsupported operator: ${filter.operator}`)
  return baseQuery
}

export const subsetOptionsToQueryKey = (
  tableName: string,
  ctx: LoadSubsetOptions
) => {
  const filters = toPostgrestParams(ctx.where).map(paramToString).join("&")

  const sorts = parseOrderByExpression(ctx.orderBy)
  const limit = ctx.limit

  const options: Record<string, string> = {}
  if (filters) {
    options["filters"] = filters
  }
  if (sorts.length > 0) {
    options["sorts"] = sorts
      .map((sort) => `${sort.field.join(".")}:${sort.direction}`)
      .join(",")
  }
  if (limit) {
    options["limit"] = limit.toString()
  }

  const result: any[] = [tableName]
  if (Object.keys(options).length > 0) {
    result.push(options)
  }
  return result
}

export const supabaseQueryFn = async (
  supabase: SupabaseClient,
  tableName: string,
  ctx: {
    client: QueryClient
    queryKey: readonly unknown[]
    signal: AbortSignal
    meta: QueryMeta | undefined
    pageParam?: unknown
    direction?: unknown
  }
) => {
  const { limit, orderBy, offset, where, cursor } =
    ctx.meta?.loadSubsetOptions || {}

  let cursorFilters: Array<SimpleComparison> = []
  if (cursor) {
    cursorFilters = [...extractSimpleComparisons(cursor.whereFrom)]
  }
  const sorts = parseOrderByExpression(orderBy)

  let baseQuery: GenericPostgrestFilterBuilder = supabase
    .from(tableName)
    .select("*")

  if (limit) {
    baseQuery = baseQuery.limit(limit)
  }

  if (offset) {
    baseQuery = baseQuery.range(offset, offset + 5)
  }
  for (const sort of sorts) {
    baseQuery = baseQuery.order(sort.field.join("."), {
      ascending: sort.direction === "asc",
    })
  }

  for (const param of toPostgrestParams(where)) {
    baseQuery = applyParam(baseQuery, param)
  }
  for (const filter of cursorFilters) {
    baseQuery = buildQuery(baseQuery, filter)
  }

  const { data, error } = await baseQuery

  if (error) {
    throw error
  }
  return data || []
}

export const supabaseOnInsert = async (
  supabase: SupabaseClient,
  tableName: string,
  { transaction, collection }: InsertMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { data, error } = await supabase
        .from(tableName)
        .insert({
          ...mutation.modified,
        })
        .select()
        .single()

      if (error) {
        throw error
      }
      mutation.modified = data
      // The data has been inserted and confirmed by the server, so we can write it to the collection
      collection.utils.writeInsert(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnUpdate = async (
  supabase: SupabaseClient,
  tableName: string,
  filter: (
    query: PostgrestFilterBuilder<any, any, any, any, any, any, any>,
    item: any
  ) => PostgrestFilterBuilder<any, any, any, any, any, any, any>,
  { transaction, collection }: UpdateMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { original, changes } = mutation
      const { error, data } = await filter(
        supabase.from(tableName).update({
          ...original,
          ...changes,
        }),
        mutation.original
      )
        .select()
        .single()

      if (error) {
        throw error
      }
      mutation.modified = data
      collection.utils.writeUpdate(data)
    })
  )

  return { refetch: false }
}

export const supabaseOnDelete = async (
  supabase: SupabaseClient,
  tableName: string,
  filter: (
    query: PostgrestFilterBuilder<any, any, any, any>,
    item: any
  ) => PostgrestFilterBuilder<any, any, any, any>,
  { transaction, collection }: DeleteMutationFnParams<any, any, any>
) => {
  await Promise.all(
    transaction.mutations.map(async (mutation) => {
      const { error } = await filter(
        supabase.from(tableName).delete(),
        mutation.original
      )

      if (error) {
        throw error
      }
      // The data has been deleted and confirmed by the server, so we can write it to the collection
      collection.utils.writeDelete(collection.getKeyFromItem(mutation.original))
    })
  )

  return { refetch: false }
}
