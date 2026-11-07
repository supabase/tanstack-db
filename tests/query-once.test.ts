import { createClient } from "@supabase/supabase-js"
import {
  add,
  and,
  avg,
  coalesce,
  concat,
  count,
  createCollection,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  length,
  like,
  localOnlyCollectionOptions,
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { queryOnce } from "../src/index"
import { VERSION } from "../src/version"
import { makePaginatingFetch } from "./pagination.utils"
import {
  createMockedTodosCollection,
  createMockedUsersCollection,
  createMockedUsersTodosCollection,
  createMockFetch,
  expectFetchUrls,
  getRequestHeaders,
  normalizeFetchUrl,
  SUPABASE_KEY,
  SUPABASE_URL,
} from "./test.utils"

describe("queryOnce PostgREST query generation", () => {
  let mockFetch: ReturnType<typeof createMockFetch>
  let supabase: ReturnType<typeof createClient>
  let usersCollection: ReturnType<typeof createMockedUsersCollection>
  let utCollection: ReturnType<typeof createMockedUsersTodosCollection>
  let todosCollection: ReturnType<typeof createMockedTodosCollection>

  beforeEach(() => {
    mockFetch = createMockFetch()
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
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
      await queryOnce((q) => q.from({ user: usersCollection }), supabase)
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })
  })

  describe("automatic X-Client-Info header", () => {
    test("is present on the request", async () => {
      await queryOnce((q) => q.from({ user: usersCollection }), supabase)
      expect(getRequestHeaders(mockFetch, 0).get("x-client-info")).toBe(
        `@supabase-labs/tanstack-db/${VERSION}`
      )
    })

    test("is present on the server aggregate path", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expect(getRequestHeaders(mockFetch, 0).get("x-client-info")).toBe(
        `@supabase-labs/tanstack-db/${VERSION}`
      )
    })
  })

  describe("WHERE", () => {
    test("WHERE active = true", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&active=eq.true"])
    })

    test("WHERE id = 1", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).where(({ user }) => eq(user.id, 1)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=eq.1"])
    })

    test("WHERE name = 'John'", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.name, "John")),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&name=eq.John"])
    })

    test("WHERE id > 5 (gt)", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).where(({ user }) => gt(user.id, 5)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=gt.5"])
    })

    test("WHERE id >= 5 (gte)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => gte(user.id, 5)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=gte.5"])
    })

    test("WHERE id < 10 (lt)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => lt(user.id, 10)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=lt.10"])
    })

    test("WHERE id <= 10 (lte)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => lte(user.id, 10)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=lte.10"])
    })

    test("WHERE id IN (1, 2, 3)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => inArray(user.id, [1, 2, 3])),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=in.(1,2,3)"])
    })

    test("WHERE NOT(active = false)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => not(eq(user.active, false))),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=not.eq.false",
      ])
    })

    test("WHERE name IS NULL", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => isNull(user.name)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&name=is.null"])
    })

    test("AND: active = true AND id > 5", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => and(eq(user.active, true), gt(user.id, 5))),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&id=gt.5",
      ])
    })

    test("chained .where", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .where(({ user }) => gt(user.id, 5)),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&id=gt.5",
      ])
    })

    test("OR: active = true OR id = 1", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => or(eq(user.active, true), eq(user.id, 1))),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&or=(active.eq.true,id.eq.1)",
      ])
    })

    test("nested AND/OR: active = true AND (id > 5 OR name = 'admin')", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              and(
                eq(user.active, true),
                or(gt(user.id, 5), eq(user.name, "admin"))
              )
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&or=(id.gt.5,name.eq.admin)",
      ])
    })
  })

  describe("SELECT columns", () => {
    test("subset of fields", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ id: user.id, name: user.name })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("field renaming", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ userId: user.id, fullName: user.name })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("computed boolean with eq falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            isActive: eq(user.active, true),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("upper(name) falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            upperName: upper(user.name),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("lower(email) falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            lowerEmail: lower(user.email),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("concat falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            nameAndEmail: concat(user.name, " ", user.email),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("length(name) falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            nameLength: length(user.name),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("add(id, 1) falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            idPlusOne: add(user.id, 1),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("coalesce falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            displayName: coalesce(user.name, "Unknown"),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("spread + computed field falls back to *", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            ...user,
            highId: gt(user.id, 5),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })
  })

  describe("Aggregate functions (pushed to PostgREST)", () => {
    test("count(id)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()",
      ])
    })

    test("sum(id)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ sumId: sum(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=sumId:id.sum()"])
    })

    test("avg(id)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ avgId: avg(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=avgId:id.avg()"])
    })

    test("min(id)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ minId: min(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=minId:id.min()"])
    })

    test("max(id)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ maxId: max(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=maxId:id.max()"])
    })

    test("multiple aggregates", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            totalUsers: count(user.id),
            maxId: max(user.id),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count(),maxId:id.max()",
      ])
    })

    test("aggregate with where", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&active=eq.true",
      ])
    })

    // Only the server aggregate path reaches this package's own translator;
    // every other query falls through to the collection loader.
    test("aggregate with LIKE / ILIKE", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => like(user.name, "%Ali%"))
            .where(({ user }) => ilike(user.email, "%ali%"))
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&name=like.%25Ali%25&email=ilike.%25ali%25",
      ])
    })

    test("aggregate with OR of ILIKEs", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              or(ilike(user.name, "%ali%"), ilike(user.email, "%ali%"))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&or=(name.ilike.%25ali%25,email.ilike.%25ali%25)",
      ])
    })

    test("aggregate with nested AND/OR of ILIKEs", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              and(
                eq(user.active, true),
                or(ilike(user.name, "%ali%"), ilike(user.email, "%ali%"))
              )
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&active=eq.true&or=(name.ilike.%25ali%25,email.ilike.%25ali%25)",
      ])
    })

    test("aggregate with an IN list inside an OR", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              or(inArray(user.id, [1, 2, 3]), eq(user.active, true))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&or=(id.in.(1,2,3),active.eq.true)",
      ])
    })

    test("aggregate quotes values containing a comma", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              or(ilike(user.name, "%a,b%"), eq(user.email, "x,y"))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        '/rest/v1/users?select=totalUsers:id.count()&or=(name.ilike."%25a,b%25",email.eq."x,y")',
      ])
    })

    test("aggregate with a negated logical group", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              not(and(eq(user.active, true), ilike(user.name, "%ali%")))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&or=(active.not.eq.true,name.not.ilike.%25ali%25)",
      ])
    })

    test("aggregate rejects unsupported filters before making a request", async () => {
      await expect(
        queryOnce(
          (q) =>
            q
              .from({ user: usersCollection })
              .where(({ user }) =>
                or(eq(user.active, true), eq(upper(user.name), "ALICE"))
              )
              .select(({ user }) => ({ totalUsers: count(user.id) })),
          supabase
        )
      ).rejects.toThrow("fully pushable filters")
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test("aggregate with NOT(name LIKE …)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => not(like(user.name, "%Ali%")))
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&name=not.like.%25Ali%25",
      ])
    })
  })

  describe("GROUP BY (falls back to *, aggregation client-side)", () => {
    test("single column groupBy", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).groupBy(({ user }) => user.active),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("single column GROUP BY with WHERE", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .groupBy(({ user }) => user.active),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&active=eq.true"])
    })

    test("GROUP BY + aggregates falls back to *", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .groupBy(({ user }) => user.active)
            .select(({ user }) => ({
              active: user.active,
              userCount: count(user.id),
            })),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&active=eq.true"])
    })
  })

  describe("HAVING (client-side)", () => {
    test("HAVING with direct aggregate", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .groupBy(({ user }) => user.active)
            .select(({ user }) => ({
              active: user.active,
              totalId: sum(user.id),
            }))
            .having(({ user }) => gt(sum(user.id), 10)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("HAVING with $selected fields", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .groupBy(({ user }) => user.active)
            .select(({ user }) => ({
              active: user.active,
              totalCount: count(user.id),
            }))
            .having(({ $selected }) => gt($selected.totalCount, 5)),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })
  })

  describe("ORDER BY", () => {
    test("default (asc)", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).orderBy(({ user }) => user.name),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&order=name.asc"])
    })

    test("explicit asc", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .orderBy(({ user }) => user.name, "asc"),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&order=name.asc"])
    })

    test("descending", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .orderBy(({ user }) => user.name, "desc"),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&order=name.desc"])
    })

    test("multi-column orderBy", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .orderBy(({ user }) => user.name, "asc")
            .orderBy(({ user }) => user.id, "desc"),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=name.asc,id.desc",
      ])
    })

    test("order by $selected/computed field is skipped", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({
              id: user.id,
              name: user.name,
              nameLength: length(user.name),
            }))
            .orderBy(({ $selected }) => $selected.nameLength, "desc"),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })
  })

  describe("LIMIT", () => {
    test.todo("basic limit", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .orderBy(({ user }) => user.id)
            .limit(10),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&order=id.asc&limit=10",
      ])
    })
  })

  describe("LIMIT + OFFSET", () => {
    test.todo("pagination (page 2)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .orderBy(({ user }) => user.id)
            .limit(20)
            .offset(20),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?order=id.asc&limit=20&offset=20&select=*",
      ])
    })
  })

  describe("Subquery in FROM", () => {
    test("filtered query as source pushes filter down", async () => {
      await queryOnce((q) => {
        const activeUsers = q
          .from({ user: usersCollection })
          .where(({ user }) => eq(user.active, true))
        return q.from({ activeUser: activeUsers })
      }, supabase)
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&active=eq.true"])
    })
  })

  describe("findOne", () => {
    test.todo("findOne with where pushes filter and limit", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.id, 1))
            .findOne(),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&id=eq.1&limit=1"])
    })
  })

  describe("DISTINCT (client-side, select=*)", () => {
    test("single column distinct", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .select(({ user }) => ({ name: user.name }))
            .distinct(),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test("distinct with where clause", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .select(({ user }) => ({ name: user.name }))
            .distinct(),
        supabase
      )
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*&active=eq.true"])
    })
  })

  describe("Combined queries", () => {
    test.todo("WHERE + ORDER BY + LIMIT", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .orderBy(({ user }) => user.name, "asc")
            .limit(10),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=name.asc&limit=10",
      ])
    })

    test("WHERE + ORDER BY", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .orderBy(({ user }) => user.name, "desc"),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&active=eq.true&order=name.desc",
      ])
    })

    test("WHERE + ORDER BY + LIMIT (gt)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => gt(user.id, 3))
            .orderBy(({ user }) => user.id)
            .limit(5),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*&id=gt.3&order=id.asc&limit=5",
      ])
    })

    test("GROUP BY + HAVING + ORDER BY($selected) + LIMIT (client-side)", async () => {
      await queryOnce(
        (q) =>
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
            .limit(10),
        supabase
      )
      // The limit applies to groups, not rows, so it must not reach PostgREST.
      expectFetchUrls(mockFetch, ["/rest/v1/users?select=*"])
    })

    test.todo("SELECT columns + WHERE + ORDER BY + LIMIT", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .select(({ user }) => ({ id: user.id, name: user.name }))
            .orderBy(({ user }) => user.name, "asc")
            .limit(5),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?active=eq.true&limit=5&order=name.asc&select=*",
      ])
    })

    test("aggregates + WHERE + LIMIT", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => eq(user.active, true))
            .select(({ user }) => ({
              totalUsers: count(user.id),
              avgId: avg(user.id),
            }))
            .limit(1),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count(),avgId:id.avg()&active=eq.true&limit=1",
      ])
    })
  })

  describe("JOIN (resource embedding)", () => {
    test("basic inner join", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .innerJoin({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*",
        "/rest/v1/users?id=in.(user_1)&select=*",
      ])
    })

    test("left join", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .leftJoin({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)",
      ])
    })

    test("right join", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .rightJoin({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*",
        "/rest/v1/users?id=in.(user_1)&select=*",
      ])
    })

    test("full join", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .fullJoin({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*",
        "/rest/v1/users_todos?select=*",
      ])
    })

    test("explicit inner join via .join()", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .join(
              { ut: utCollection },
              ({ user, ut }) => eq(user.id, ut.user_id),
              "inner"
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*",
        "/rest/v1/users?id=in.(user_1)&select=*",
      ])
    })

    test("(left) join with select", async () => {
      await queryOnce(
        (q) =>
          q.from({ user: usersCollection }).select(({ user }) => ({
            id: user.id,
            todos: q
              .from({ ut: utCollection })
              .where(({ ut }) => eq(ut.user_id, user.id)),
          })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)",
      ])
    })

    test("two chained joins (users -> users_todos -> todos)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .join({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            )
            .join({ todo: todosCollection }, ({ ut, todo }) =>
              eq(ut?.todo_id, todo.id)
            ),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)",
        "/rest/v1/todos?id=in.(todo_1)&select=*",
      ])
    })

    test("JOIN + WHERE", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .join({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            )
            .where(({ user }) => eq(user.active, true)),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?active=eq.true&select=*",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)",
      ])
    })

    test("JOIN + WHERE + SELECT + ORDER BY", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .join({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            )
            .join({ todo: todosCollection }, ({ ut, todo }) =>
              eq(ut?.todo_id, todo.id)
            )
            .where(({ todo }) => eq(todo?.completed, false))
            .select(({ user, todo }) => ({
              userName: user.name,
              todoTitle: todo?.title,
            }))
            .orderBy(({ user }) => user.name, "asc"),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?order=name.asc&select=*",
        "/rest/v1/users_todos?select=*&user_id=in.(user_1)",
        "/rest/v1/todos?id=in.(todo_1)&select=*",
      ])
    })

    test("filtered subquery as join target", async () => {
      await queryOnce((q) => {
        const activeUserTodos = q
          .from({ ut: utCollection })
          .where(({ ut }) => gt(ut.todo_id, 0))
        return q
          .from({ user: usersCollection })
          .join({ ut: activeUserTodos }, ({ user, ut }) =>
            eq(user.id, ut.user_id)
          )
      }, supabase)
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=*",
        "/rest/v1/users_todos?select=*&todo_id=gt.0&user_id=in.(user_1)",
      ])
    })

    test("aggregate over a join is computed client-side", async () => {
      // Pushed as-is, `count(ut.todo_id)` would lose its alias and count a
      // `todo_id` column on users, so the join stays on the collection loader.
      const rows = await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .innerJoin({ ut: utCollection }, ({ user, ut }) =>
              eq(user.id, ut.user_id)
            )
            .select(({ ut }) => ({ todoCount: count(ut.todo_id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users_todos?select=*",
        "/rest/v1/users?id=in.(user_1)&select=*",
      ])
      expect(rows).toMatchObject([{ todoCount: 1 }])
    })
  })
})

describe("queryOnce pagination", () => {
  // Five users behind a mock whose server cap is 2 rows per request.
  const USERS = [
    { id: 1, name: "A", email: "a@t", active: true },
    { id: 2, name: "B", email: "b@t", active: true },
    { id: 3, name: "C", email: "c@t", active: true },
    { id: 4, name: "D", email: "d@t", active: true },
    { id: 5, name: "E", email: "e@t", active: true },
  ]

  test("a non-aggregate queryOnce returns the full multi-page set", async () => {
    // Non-aggregate queryOnce loads its source collection through the same
    // supabaseQueryFn as live queries, so it inherits the db-max-rows paging
    // loop for free — the full set comes back despite the cap.
    const mockFetch = makePaginatingFetch(USERS, { cap: 2 })
    const users = createMockedUsersCollection(mockFetch)
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    const rows = await queryOnce((q) => q.from({ user: users }), supabase)

    expect(
      (rows as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5])

    await users.cleanup()
  })

  test("an ungrouped aggregate queryOnce stays a single executeQuery request", async () => {
    // Ungrouped aggregates are pushed to PostgREST and bypass supabaseQueryFn,
    // so they do NOT paginate: exactly one request is issued.
    const mockFetch = makePaginatingFetch(USERS, { cap: 2 })
    const users = createMockedUsersCollection(mockFetch)
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })

    await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .select(({ user }) => ({ total: count(user.id) })),
      supabase
    )

    const gets = mockFetch.mock.calls.filter(
      (call) => (call[1]?.method ?? "GET") === "GET"
    )
    expect(gets).toHaveLength(1)

    await users.cleanup()
  })
})

describe("queryOnce GROUP BY / HAVING results", () => {
  // Five users split across two groups, behind a mock whose server cap is 2
  // rows per request, so grouping must see every page to be correct.
  const USERS = [
    { id: 1, name: "A", email: "a@t", active: true },
    { id: 2, name: "B", email: "b@t", active: false },
    { id: 3, name: "C", email: "c@t", active: true },
    { id: 4, name: "D", email: "d@t", active: true },
    { id: 5, name: "E", email: "e@t", active: false },
  ]

  let mockFetch: ReturnType<typeof makePaginatingFetch>
  let users: ReturnType<typeof createMockedUsersCollection>
  let supabase: ReturnType<typeof createClient>

  beforeEach(() => {
    mockFetch = makePaginatingFetch(USERS, { cap: 2 })
    users = createMockedUsersCollection(mockFetch)
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
  })

  afterEach(async () => {
    await users.cleanup()
  })

  const byActive = (rows: Array<{ active: boolean }>) =>
    [...rows].sort((a, b) => Number(b.active) - Number(a.active))

  test("groups rows and computes aggregates across every page", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
            idSum: sum(user.id),
          })),
      supabase
    )

    expect(byActive(rows)).toMatchObject([
      { active: true, userCount: 3, idSum: 8 },
      { active: false, userCount: 2, idSum: 7 },
    ])
  })

  test("applies WHERE before grouping", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .where(({ user }) => gt(user.id, 2))
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
          })),
      supabase
    )

    expect(byActive(rows)).toMatchObject([
      { active: true, userCount: 2 },
      { active: false, userCount: 1 },
    ])
  })

  test("filters groups with HAVING", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
          }))
          .having(({ $selected }) => gt($selected.userCount, 2)),
      supabase
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ active: true, userCount: 3 })
  })

  test("applies LIMIT to groups, not rows", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .groupBy(({ user }) => user.active)
          .select(({ user }) => ({
            active: user.active,
            userCount: count(user.id),
          }))
          .orderBy(({ $selected }) => $selected.userCount, "desc")
          .limit(1),
      supabase
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ active: true, userCount: 3 })
  })

  test("groups a collection not backed by Supabase without a request", async () => {
    const local = createCollection(
      localOnlyCollectionOptions({
        getKey: (row: { id: number; active: boolean }) => row.id,
        initialData: [
          { id: 1, active: true },
          { id: 2, active: true },
        ],
      })
    )

    const rows = await queryOnce(
      (q) =>
        q
          .from({ row: local })
          .groupBy(({ row }) => row.active)
          .select(({ row }) => ({ rowCount: count(row.id) })),
      supabase
    )

    expect(mockFetch).not.toHaveBeenCalled()
    expect(rows).toMatchObject([{ rowCount: 2 }])
  })
})

describe("queryOnce server aggregate routing", () => {
  // Five users behind a mock whose server cap is 2 rows per request. The mock
  // ignores `select`, so a query wrongly sent down the server aggregate path
  // would get raw user rows back instead of the aggregate.
  const USERS = [
    { id: 1, name: "A", email: "a@t", active: true },
    { id: 2, name: "B", email: "b@t", active: false },
    { id: 3, name: "C", email: "c@t", active: true },
    { id: 4, name: "D", email: "d@t", active: true },
    { id: 5, name: "E", email: "e@t", active: false },
  ]
  const AGGREGATE_SELECT = /\.(count|sum|avg|min|max)\(\)/

  let mockFetch: ReturnType<typeof makePaginatingFetch>
  let users: ReturnType<typeof createMockedUsersCollection>
  let supabase: ReturnType<typeof createClient>

  beforeEach(() => {
    mockFetch = makePaginatingFetch(USERS, { cap: 2 })
    users = createMockedUsersCollection(mockFetch)
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
  })

  afterEach(async () => {
    await users.cleanup()
  })

  /** Asserts the rows were fetched and aggregated client-side */
  const expectClientSide = () => {
    const urls = mockFetch.mock.calls.map(([url]) => normalizeFetchUrl(url))
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).not.toMatch(AGGREGATE_SELECT)
    }
  }

  test("computes an aggregate beside a computed field client-side", async () => {
    const rows = await queryOnce(
      (q) =>
        q.from({ user: users }).select(({ user }) => ({
          total: count(user.id),
          nextId: add(max(user.id), 1),
        })),
      supabase
    )

    expectClientSide()
    expect(rows).toMatchObject([{ total: 5, nextId: 6 }])
  })

  test("does not group by a plain column selected beside an aggregate", async () => {
    // PostgREST would group `select=active,total:id.count()` by `active`.
    const rows = await queryOnce(
      (q) =>
        q.from({ user: users }).select(({ user }) => ({
          active: user.active,
          total: count(user.id),
        })),
      supabase
    )

    expectClientSide()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ total: 5 })
  })

  test("applies fn.where before aggregating", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .fn.where(({ user }) => user.id > 2)
          .select(({ user }) => ({ total: count(user.id) })),
      supabase
    )

    expectClientSide()
    expect(rows).toMatchObject([{ total: 3 }])
  })

  test("applies fn.having to the aggregate row", async () => {
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .select(({ user }) => ({ total: count(user.id) }))
          .fn.having(({ $selected }) => $selected.total > 10),
      supabase
    )

    expectClientSide()
    expect(rows).toEqual([])
  })

  test("aggregates over a subquery that limits its source", async () => {
    const rows = await queryOnce((q) => {
      const firstTwo = q
        .from({ user: users })
        .orderBy(({ user }) => user.id)
        .limit(2)
      return q
        .from({ top: firstTwo })
        .select(({ top }) => ({ total: count(top.id) }))
    }, supabase)

    expectClientSide()
    expect(rows).toMatchObject([{ total: 2 }])
  })
})

describe("queryOnce server aggregate path", () => {
  // Answers every request the way PostgREST answers an aggregate-only select.
  let mockFetch: ReturnType<typeof createMockFetch>
  let users: ReturnType<typeof createMockedUsersCollection>
  let supabase: ReturnType<typeof createClient>

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ total: 5 }]), {
          headers: { "content-type": "application/json" },
        })
      )
    )
    users = createMockedUsersCollection(mockFetch)
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      global: { fetch: mockFetch },
    })
  })

  afterEach(async () => {
    await users.cleanup()
  })

  test("findOne resolves to the aggregate row, not an array", async () => {
    const result = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .select(({ user }) => ({ total: count(user.id) }))
          .findOne(),
      supabase
    )

    expectFetchUrls(mockFetch, ["/rest/v1/users?select=total:id.count()"])
    expect(result).toEqual({ total: 5 })
  })

  test("does not push ORDER BY beside an aggregate", async () => {
    // Postgres rejects ORDER BY on a column outside the aggregates, and a
    // single row has nothing to order.
    const rows = await queryOnce(
      (q) =>
        q
          .from({ user: users })
          .orderBy(({ user }) => user.name)
          .select(({ user }) => ({ total: count(user.id) })),
      supabase
    )

    expectFetchUrls(mockFetch, ["/rest/v1/users?select=total:id.count()"])
    expect(rows).toEqual([{ total: 5 }])
  })

  test("pushes the filters of a filter-only subquery source", async () => {
    const rows = await queryOnce((q) => {
      const laterUsers = q
        .from({ user: users })
        .where(({ user }) => gt(user.id, 2))
      return q
        .from({ later: laterUsers })
        .select(({ later }) => ({ total: count(later.id) }))
    }, supabase)

    expectFetchUrls(mockFetch, [
      "/rest/v1/users?select=total:id.count()&id=gt.2",
    ])
    expect(rows).toEqual([{ total: 5 }])
  })

  test("computes an aggregate over a collection not backed by Supabase client-side", async () => {
    // A collection this package did not create has no table behind it, so
    // pushing its aggregate would query a table named after its id.
    const local = createCollection(
      localOnlyCollectionOptions({
        getKey: (row: { id: number }) => row.id,
        initialData: [{ id: 1 }, { id: 2 }],
      })
    )

    const rows = await queryOnce(
      (q) =>
        q.from({ row: local }).select(({ row }) => ({ total: count(row.id) })),
      supabase
    )

    expect(mockFetch).not.toHaveBeenCalled()
    expect(rows).toMatchObject([{ total: 2 }])
  })
})
