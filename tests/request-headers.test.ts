import { afterEach, describe, expect, test } from "vitest"
import pkg from "../package.json"
import { VERSION } from "../src/version"
import {
  createMockedUsersCollection,
  createMockFetch,
  getRequestHeaders,
  queryResult,
} from "./test.utils"

const EXPECTED_CLIENT_INFO = `@supabase-labs/tanstack-db/${VERSION}`

test("VERSION stays in sync with package.json", () => {
  expect(VERSION).toBe(pkg.version)
})

describe("automatic X-Client-Info header", () => {
  let collection: ReturnType<typeof createMockedUsersCollection>

  afterEach(() => {
    collection?.cleanup()
  })

  test("is present on select requests", async () => {
    const mockFetch = createMockFetch()
    collection = createMockedUsersCollection(mockFetch)

    await queryResult((q) => q.from({ user: collection }))

    expect(getRequestHeaders(mockFetch, 0).get("x-client-info")).toBe(
      EXPECTED_CLIENT_INFO
    )
  })

  test("is present on insert requests", async () => {
    const mockFetch = createMockFetch()
    collection = createMockedUsersCollection(mockFetch)
    await queryResult((q) => q.from({ user: collection }))

    const tx = collection.insert({
      id: 2,
      name: "Bob",
      email: "bob@test.com",
      active: true,
    })
    await tx.isPersisted.promise

    const lastCall = mockFetch.mock.calls.length - 1
    expect(getRequestHeaders(mockFetch, lastCall).get("x-client-info")).toBe(
      EXPECTED_CLIENT_INFO
    )
  })

  test("is present on update requests", async () => {
    const mockFetch = createMockFetch()
    collection = createMockedUsersCollection(mockFetch)
    await queryResult((q) => q.from({ user: collection }))

    const insertTx = collection.insert({
      id: 2,
      name: "Bob",
      email: "bob@test.com",
      active: true,
    })
    await insertTx.isPersisted.promise

    const updateTx = collection.update("2", (draft) => {
      draft.name = "Bobby"
    })
    await updateTx.isPersisted.promise

    const lastCall = mockFetch.mock.calls.length - 1
    expect(getRequestHeaders(mockFetch, lastCall).get("x-client-info")).toBe(
      EXPECTED_CLIENT_INFO
    )
  })

  test("is present on delete requests", async () => {
    const mockFetch = createMockFetch()
    collection = createMockedUsersCollection(mockFetch)
    await queryResult((q) => q.from({ user: collection }))

    const insertTx = collection.insert({
      id: 2,
      name: "Bob",
      email: "bob@test.com",
      active: true,
    })
    await insertTx.isPersisted.promise

    const deleteTx = collection.delete("2")
    await deleteTx.isPersisted.promise

    const lastCall = mockFetch.mock.calls.length - 1
    expect(getRequestHeaders(mockFetch, lastCall).get("x-client-info")).toBe(
      EXPECTED_CLIENT_INFO
    )
  })
})
