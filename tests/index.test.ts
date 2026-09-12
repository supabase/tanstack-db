import {
  add,
  and,
  avg,
  coalesce,
  concat,
  count,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  isUndefined,
  length,
  like,
  lower,
  lt,
  lte,
  max,
  min,
  not,
  or,
  sum,
  upper,
} from "@tanstack/db"
import { afterEach, beforeEach, describe, test } from "vitest"
import {
  createMockedTodosCollection,
  createMockedUsersCollection,
  createMockedUsersTodosCollection,
  createMockFetch,
  expectFetchUrls,
  queryResult,
} from "./test.utils"

describe("PostgREST query generation", () => {
  let mockFetch: ReturnType<typeof createMockFetch>
  let usersCollection: ReturnType<typeof createMockedUsersCollection>
  let utCollection: ReturnType<typeof createMockedUsersTodosCollection>
  let todosCollection: ReturnType<typeof createMockedTodosCollection>

  beforeEach(() => {
    mockFetch = createMockFetch()
    usersCollection = createMockedUsersCollection(mockFetch)
    utCollection = createMockedUsersTodosCollection(mockFetch)
    todosCollection = createMockedTodosCollection(mockFetch)
  })

  afterEach(() => {
    usersCollection?.cleanup()
    utCollection?.cleanup()
    todosCollection?.cleanup()
  })

  describe("FROM", () => {
    test("SELECT * FROM users", async () => {
      await queryResult((q) => q.from({ user: usersCollection }))
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("WHERE", () => {
    test("WHERE active = true", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id = 1", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => eq(user.id, 1))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=eq.1&order=id.asc&limit=1000",
      ])
    })

    test("WHERE name = 'John'", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.name, "John"))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=eq.John&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id > 5 (gt)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => gt(user.id, 5))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=gt.5&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id >= 5 (gte)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => gte(user.id, 5))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=gte.5&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id < 10 (lt)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => lt(user.id, 10))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=lt.10&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id <= 10 (lte)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => lte(user.id, 10))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=lte.10&order=id.asc&limit=1000",
      ])
    })

    test("WHERE id IN (1, 2, 3)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => inArray(user.id, [1, 2, 3]))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=in.(1,2,3)&order=id.asc&limit=1000",
      ])
    })

    test("merges IN filters for the same column", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            and(inArray(user.id, [1, 2]), inArray(user.id, [2, 3]))
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=in.(1,2,3)&order=id.asc&limit=1000",
      ])
    })

    test("keeps IN filters for different columns separate", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            and(inArray(user.id, [1, 2]), inArray(user.name, ["Alice", "Bob"]))
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=in.(1,2)&name=in.(Alice,Bob)&order=id.asc&limit=1000",
      ])
    })

    test("WHERE NOT(active = false)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => not(eq(user.active, false)))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=not.eq.false&order=id.asc&limit=1000",
      ])
    })

    test("WHERE NOT(id > 5)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => not(gt(user.id, 5)))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=not.gt.5&order=id.asc&limit=1000",
      ])
    })

    test("WHERE NOT(id IN (1, 2))", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => not(inArray(user.id, [1, 2])))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=not.in.(1,2)&order=id.asc&limit=1000",
      ])
    })

    test("a Date value is sent as ISO 8601", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            gt(user.name, new Date("2026-01-02T03:04:05.000Z") as never)
          )
      )
      // `Date.toString()` would produce something Postgres cannot cast.
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=gt.2026-01-02T03:04:05.000Z&order=id.asc&limit=1000",
      ])
    })

    test("Date values inside an IN filter are sent as ISO 8601", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            inArray(user.name, [
              new Date("2026-01-02T03:04:05.000Z"),
              new Date("2026-02-03T04:05:06.000Z"),
            ] as never)
          )
      )
      // Each list member goes through quoteValue, which must also render Dates
      // as ISO 8601 rather than the locale string from `Date.toString()`.
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=in.(2026-01-02T03:04:05.000Z,2026-02-03T04:05:06.000Z)&order=id.asc&limit=1000",
      ])
    })

    test("WHERE name IS NULL", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => isNull(user.name))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=is.null&order=id.asc&limit=1000",
      ])
    })

    test("WHERE NOT(name IS NULL)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => not(isNull(user.name)))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=not.is.null&order=id.asc&limit=1000",
      ])
    })

    test("a negated condition does not reuse the cache entry of the plain one", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).where(({ user }) => gt(user.id, 5))
      )
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => not(gt(user.id, 5)))
      )
      // Two fetches, not one: a shared query key would have served the second
      // query the first query's rows.
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=gt.5&order=id.asc&limit=1000",
        "/rest/v1/users?select=*&id=not.gt.5&order=id.asc&limit=1000",
      ])
    })

    test("AND: active = true AND id > 5", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => and(eq(user.active, true), gt(user.id, 5)))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&id=gt.5&order=id.asc&limit=1000",
      ])
    })

    test("chained .where", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .where(({ user }) => gt(user.id, 5))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&id=gt.5&order=id.asc&limit=1000",
      ])
    })

    test("WHERE name LIKE '%Ali%'", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => like(user.name, "%Ali%"))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=like.%25Ali%25&order=id.asc&limit=1000",
      ])
    })

    test("WHERE name ILIKE '%ali%'", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => ilike(user.name, "%ali%"))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&name=ilike.%25ali%25&order=id.asc&limit=1000",
      ])
    })

    test("OR: active = true OR id = 1", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => or(eq(user.active, true), eq(user.id, 1)))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&or=(active.eq.true,id.eq.1)&order=id.asc&limit=1000",
      ])
    })

    test("OR of ILIKEs (search across columns)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            or(ilike(user.name, "%ali%"), ilike(user.email, "%ali%"))
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&or=(name.ilike.%25ali%25,email.ilike.%25ali%25)&order=id.asc&limit=1000",
      ])
    })

    test("nested AND/OR: active = true AND (id > 5 OR name = 'admin')", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            and(
              eq(user.active, true),
              or(gt(user.id, 5), eq(user.name, "admin"))
            )
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&or=(id.gt.5,name.eq.admin)&order=id.asc&limit=1000",
      ])
    })

    test("nested AND/OR of ILIKEs", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            and(
              eq(user.active, true),
              or(ilike(user.name, "%ali%"), ilike(user.email, "%ali%"))
            )
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&or=(name.ilike.%25ali%25,email.ilike.%25ali%25)&order=id.asc&limit=1000",
      ])
    })

    test("value containing a comma is quoted", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            or(ilike(user.name, "%a,b%"), eq(user.email, "x,y"))
          )
      )
      expectFetchUrls(mockFetch, [
        '/rest/v1/users?select=*&or=(name.ilike."%25a,b%25",email.eq."x,y")&order=id.asc&limit=1000',
      ])
    })

    test("IN list quotes members containing reserved characters", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => inArray(user.name, ["plain", "a,b", "c(d)"]))
      )
      expectFetchUrls(mockFetch, [
        '/rest/v1/users?select=*&name=in.(plain,"a,b","c(d)")&order=id.asc&limit=1000',
      ])
    })

    test("AND drops only the unpushable conjunct", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            and(eq(user.active, true), eq(upper(user.name), "ALICE"))
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=id.asc&limit=1000",
      ])
    })

    test("OR containing an unpushable branch is dropped entirely", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) =>
            or(eq(user.active, true), eq(upper(user.name), "ALICE"))
          )
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("SELECT columns (client-side)", () => {
    test("subset of fields", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ id: user.id, name: user.name }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("field renaming", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ userId: user.id, fullName: user.name }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("computed boolean with eq", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          isActive: eq(user.active, true),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("upper(name)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          upperName: upper(user.name),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("lower(email)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          lowerEmail: lower(user.email),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("concat(name, ' ', email)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          nameAndEmail: concat(user.name, " ", user.email),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("length(name)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          nameLength: length(user.name),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("add(id, 1)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          idPlusOne: add(user.id, 1),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("coalesce(name, 'Unknown')", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          displayName: coalesce(user.name, "Unknown"),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("spread + computed field", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          ...user,
          highId: gt(user.id, 5),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("Aggregate functions (client-side)", () => {
    test("count(id)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ totalUsers: count(user.id) }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("sum(id)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ sumId: sum(user.id) }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("avg(id)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ avgId: avg(user.id) }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("min(id)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ minId: min(user.id) }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("max(id)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ maxId: max(user.id) }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("multiple aggregates", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          totalUsers: count(user.id),
          maxId: max(user.id),
        }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("order by $selected/computed field", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({
            id: user.id,
            name: user.name,
            nameLength: length(user.name),
          }))
          .orderBy(({ $selected }) => $selected.nameLength, "desc")
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("GROUP BY (client-side)", () => {
    test("single column groupBy", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).groupBy(({ user }) => user.active)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("single column GROUP BY with WHERE", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .groupBy(({ user }) => user.active)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?active=eq.true&select=*&order=id.asc&limit=1000",
      ])
    })

    test("multiple columns GROUP BY", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .groupBy(({ user }) => [user.active, user.name])
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("GROUP BY + aggregates", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
          }))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?active=eq.true&select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("HAVING (client-side)", () => {
    test("HAVING with direct aggregate", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            totalId: sum(user.id),
          }))
          .having(({ user }) => gt(sum(user.id), 10))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("HAVING with $selected fields", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            totalCount: count(user.id),
          }))
          .having(({ $selected }) => gt($selected.totalCount, 5))
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("ORDER BY", () => {
    test("default (asc)", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).orderBy(({ user }) => user.name)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=name.asc,id.asc&limit=1000",
      ])
    })

    test("explicit asc", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .orderBy(({ user }) => user.name, "asc")
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=name.asc,id.asc&limit=1000",
      ])
    })

    test("descending", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .orderBy(({ user }) => user.name, "desc")
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=name.desc,id.asc&limit=1000",
      ])
    })

    test("multi-column orderBy", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .orderBy(({ user }) => user.name, "asc")
          .orderBy(({ user }) => user.id, "desc")
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=name.asc,id.desc&limit=1000",
      ])
    })
  })

  describe("LIMIT", () => {
    test("basic limit", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .orderBy(({ user }) => user.id)
          .limit(10)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=10",
      ])
    })
  })

  describe("LIMIT + OFFSET", () => {
    test.todo("pagination (page 2)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .orderBy(({ user }) => user.id)
          .limit(20)
          .offset(20)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=20&offset=20",
      ])
    })
  })

  describe("Subquery in FROM", () => {
    test("filtered query as source pushes filter down", async () => {
      await queryResult((q) => {
        const activeUsers = q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
        return q.from({ activeUser: activeUsers })
      })
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=id.asc&limit=1000",
      ])
    })
  })

  describe("findOne", () => {
    test.todo("findOne with where pushes filter and limit", async () => {
      // findOne doesn't use limit=1 in Tanstack DB
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.id, 1))
          .findOne()
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=eq.1&limit=1&order=id.asc",
      ])
    })
  })

  describe("DISTINCT (client-side)", () => {
    test("single column distinct", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ name: user.name }))
          .distinct()
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("multi column distinct", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .select(({ user }) => ({ name: user.name, active: user.active }))
          .distinct()
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })

    test("distinct with where clause", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .select(({ user }) => ({ name: user.name }))
          .distinct()
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?active=eq.true&select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("Combined queries", () => {
    test("WHERE + ORDER BY + LIMIT", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .orderBy(({ user }) => user.name, "asc")
          .limit(10)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=name.asc,id.asc&limit=10",
      ])
    })

    test("WHERE + ORDER BY", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
          .orderBy(({ user }) => user.name, "desc")
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=name.desc,id.asc&limit=1000",
      ])
    })

    test("WHERE + ORDER BY + LIMIT", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .where(({ user }) => gt(user.id, 3))
          .orderBy(({ user }) => user.id)
          .limit(5)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=gt.3&order=id.asc&limit=5",
      ])
    })

    test("GROUP BY + HAVING + ORDER BY($selected) + LIMIT (client-side)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
            maxId: max(user.id),
          }))
          .having(({ $selected }) => gt($selected.userCount, 0))
          .orderBy(({ $selected }) => $selected.userCount, "desc")
          .limit(10)
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
      ])
    })
  })

  describe("JOIN", () => {
    test("basic inner join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .innerJoin({ ut: utCollection }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*&order=user_id.asc,todo_id.asc&limit=1000",
        "/rest/v1/users?id=in.(user_1)&select=*&order=id.asc&limit=1000",
      ])
    })

    test("(left) join with select", async () => {
      await queryResult((q) =>
        q.from({ user: usersCollection }).select(({ user }) => ({
          id: user.id,
          todos: q
            .from({ ut: utCollection })
            .where(({ ut }) => eq(ut.user_id, user.id)),
        }))
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("explicit inner join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .join(
            { ut: utCollection },
            ({ user, ut }) => eq(user.id, ut.user_id),
            "inner"
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*&order=user_id.asc,todo_id.asc&limit=1000",
        "/rest/v1/users?id=in.(user_1)&select=*&order=id.asc&limit=1000",
      ])
    })

    test("left join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .leftJoin({ ut: utCollection }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("right join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .rightJoin({ ut: utCollection }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*&order=user_id.asc,todo_id.asc&limit=1000",
        "/rest/v1/users?id=in.(user_1)&select=*&order=id.asc&limit=1000",
      ])
    })

    test("full join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .fullJoin({ ut: utCollection }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("two chained joins (users -> users_todos -> todos)", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .join({ ut: utCollection }, ({ user, ut }) => eq(user.id, ut.user_id))
          .join({ todo: todosCollection }, ({ ut, todo }) =>
            eq(ut?.todo_id, todo.id)
          )
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
        "/rest/v1/todos?id=in.(todo_1)&select=*&order=id.asc&limit=1000",
      ])
    })

    test("JOIN + WHERE + SELECT", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .join({ ut: utCollection }, ({ user, ut }) => eq(user.id, ut.user_id))
          .join({ todo: todosCollection }, ({ ut, todo }) =>
            eq(ut?.todo_id, todo.id)
          )
          .where(({ todo }) => eq(todo?.completed, false))
          .select(({ user, todo }) => ({
            userName: user.name,
            todoTitle: todo?.title,
          }))
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
        "/rest/v1/todos?id=in.(todo_1)&select=*&order=id.asc&limit=1000",
      ])
    })

    test("filtered subquery as join target", async () => {
      await queryResult((q) => {
        const activeUserTodos = q
          .from({ ut: utCollection })
          .where(({ ut }) => gt(ut.todo_id, 0))
        return q
          .from({ user: usersCollection })
          .join({ ut: activeUserTodos }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      })

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&todo_id=gt.0&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("deduplicated subquery used in multiple joins", async () => {
      await queryResult((q) => {
        const userTodos = q.from({ ut: utCollection })
        return q
          .from({ user: usersCollection })
          .join({ ut: userTodos }, ({ user, ut }) => eq(user.id, ut.user_id))
          .join({ ut: userTodos }, ({ user, ut }) => eq(user.id, ut?.user_id))
      })

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("subquery with groupBy + aggregates joined to another query", async () => {
      await queryResult((q) => {
        const todoCountsByUser = q
          .from({ ut: utCollection })
          .groupBy(({ ut }) => ut.user_id)
          .select(({ ut }) => ({
            user_id: ut.user_id,
            todoCount: count(ut.todo_id),
          }))
        return q
          .from({ user: usersCollection })
          .join({ stats: todoCountsByUser }, ({ user, stats }) =>
            eq(user.id, stats.user_id)
          )
          .select(({ user, stats }) => ({
            userName: user.name,
            todoCount: stats?.todoCount,
          }))
      })

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })

    test("find unmatched rows in left join", async () => {
      await queryResult((q) =>
        q
          .from({ user: usersCollection })
          .leftJoin({ ut: utCollection }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
          .where(({ ut }) => isUndefined(ut))
      )

      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=1000",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)&order=user_id.asc,todo_id.asc&limit=1000",
      ])
    })
  })
})
