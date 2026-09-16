import { vi } from "vitest"

type Row = Record<string, number | string | boolean>

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
}

/**
 * A mock `fetch` that serves a fixture like PostgREST would for the read paths
 * the pagination adapter emits: single-column `order`, `limit`, `offset`, and
 * `col=op.value` scalar filters (`gt`/`gte`/`lt`/`lte`/`eq`). Non-GET requests
 * echo their body back so inserts/updates parse.
 */
export function makePaginatingFetch(fixture: Row[]) {
  const columns = Object.keys(fixture[0] ?? {})
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const method = init?.method ?? "GET"
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      return Promise.resolve(json(body))
    }

    const params = new URL(String(input)).searchParams
    let rows = [...fixture]

    for (const column of columns) {
      for (const raw of params.getAll(column)) {
        const [op, value] = raw.split(/\.(.*)/s)
        const compare = COMPARATORS[op]
        if (compare) {
          const target = Number(value)
          rows = rows.filter((r) => compare(Number(r[column]), target))
        }
      }
    }

    const order = params.get("order")
    if (order) {
      const [column, direction] = order.split(",")[0].split(".")
      const sign = direction === "desc" ? -1 : 1
      rows.sort((a, b) => (Number(a[column]) - Number(b[column])) * sign)
    }

    const offset = params.get("offset") ? Number(params.get("offset")) : 0
    const limit = params.get("limit")
    rows = rows.slice(
      offset,
      limit === null ? undefined : offset + Number(limit)
    )
    return Promise.resolve(json(rows))
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/**
 * The decoded query strings of every GET the mock captured, in order, with the
 * leading `?` stripped (e.g. `select=*&order=id.asc&limit=2&id=gt.3`).
 */
export function getSearches(
  mockFetch: ReturnType<typeof makePaginatingFetch>
): string[] {
  return mockFetch.mock.calls
    .filter((call) => (call[1]?.method ?? "GET") === "GET")
    .map((call) =>
      decodeURIComponent(new URL(String(call[0])).search).replace(/^\?/, "")
    )
}
