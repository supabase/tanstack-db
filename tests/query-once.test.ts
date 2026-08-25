import { createClient } from "@supabase/supabase-js"
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
import { queryOnce } from "../src/index"
import {
  createMockedTodosCollection,
  createMockedUsersCollection,
  createMockedUsersTodosCollection,
  createMockFetch,
  expectFetchUrls,
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

    // Only the aggregate / groupBy / having path reaches this package's own
    // translator; every other query falls through to the collection loader.
    test("aggregate with LIKE / ILIKE", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => like(user.name, "*Ali*"))
            .where(({ user }) => ilike(user.email, "*ali*"))
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&name=like.*Ali*&email=ilike.*ali*",
      ])
    })

    test("aggregate with OR of ILIKEs", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) =>
              or(ilike(user.name, "*ali*"), ilike(user.email, "*ali*"))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&or=(name.ilike.*ali*,email.ilike.*ali*)",
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
                or(ilike(user.name, "*ali*"), ilike(user.email, "*ali*"))
              )
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&active=eq.true&or=(name.ilike.*ali*,email.ilike.*ali*)",
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
              or(ilike(user.name, "*a,b*"), eq(user.email, "x,y"))
            )
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        '/rest/v1/users?select=totalUsers:id.count()&or=(name.ilike."*a,b*",email.eq."x,y")',
      ])
    })

    test("aggregate with NOT(name LIKE …)", async () => {
      await queryOnce(
        (q) =>
          q
            .from({ user: usersCollection })
            .where(({ user }) => not(like(user.name, "*Ali*")))
            .select(({ user }) => ({ totalUsers: count(user.id) })),
        supabase
      )
      expectFetchUrls(mockFetch, [
        "/rest/v1/users?select=totalUsers:id.count()&name=not.like.*Ali*",
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
    test("basic limit", async () => {
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
    test("WHERE + ORDER BY + LIMIT", async () => {
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
      expectFetchUrls(mockFetch, ["/rest/v1/users?limit=10&select=*"])
    })

    test("SELECT columns + WHERE + ORDER BY + LIMIT", async () => {
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
  })
})
