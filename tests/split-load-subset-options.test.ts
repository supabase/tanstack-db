import type { LoadSubsetOptions } from "@tanstack/db"
import { and, eq, gt, IR, inArray, not, or } from "@tanstack/db"
import { describe, expect, test } from "vitest"
import {
  cursorCurrentToSearch,
  loadSubsetOptionsToSearch,
  splitLoadSubsetOptions,
} from "../src/postgrest-filters"
import { flattenAnd } from "../src/postgrest-filters/common"

// A short stand-in for `supabase.from(table).url`; only its length matters.
const BASE_URL = "http://localhost:54321/rest/v1/items"

const id = new IR.PropRef(["id"])
const other = new IR.PropRef(["other"])
const active = new IR.PropRef(["active"])

// Mirrors `measureSubset` in src/functions.ts, minus the real supabase client:
// renders the same URLs the adapter would send and measures their length.
const measure = (options: LoadSubsetOptions): number => {
  const mainLength =
    BASE_URL.length + loadSubsetOptionsToSearch(options).toString().length
  const tiesSearch = cursorCurrentToSearch(options)
  return tiesSearch
    ? Math.max(mainLength, BASE_URL.length + tiesSearch.toString().length)
    : mainLength
}

const split = (options: LoadSubsetOptions, maxUrlLength: number) =>
  splitLoadSubsetOptions(options, { maxUrlLength, measure })

// Every chunk's rendered URL (main request, plus the tie request when the
// subset has a cursor) must fit the budget.
const expectEveryChunkFits = (
  chunks: LoadSubsetOptions[],
  maxUrlLength: number
) => {
  for (const chunk of chunks) {
    expect(measure(chunk)).toBeLessThanOrEqual(maxUrlLength)
  }
}

// Collects the values of every top-level `in(ref, [...])` conjunct matching
// `path`, across every chunk — the union a caller reconstructs by
// concatenating each chunk's rows.
const inValuesFor = (chunks: LoadSubsetOptions[], path: string[]): unknown[] =>
  chunks.flatMap((chunk) => {
    if (!chunk.where) return []
    return flattenAnd(chunk.where).flatMap((expr) => {
      if (expr.type !== "func" || expr.name !== "in") return []
      const [left, right] = expr.args
      if (
        left?.type !== "ref" ||
        JSON.stringify(left.path) !== JSON.stringify(path) ||
        right?.type !== "val" ||
        !Array.isArray(right.value)
      ) {
        return []
      }
      return right.value
    })
  })

describe("splitLoadSubsetOptions", () => {
  test("returns the identical object when the subset already fits", () => {
    const options: LoadSubsetOptions = { where: inArray(id, [1, 2, 3]) }
    const result = split(options, 8000)
    expect(result).toEqual([options])
    expect(result[0]).toBe(options)
  })

  test("splits string ids with commas and quotes, and Dates, so every chunk fits", () => {
    const values = [
      'Alice, "A"',
      "Bob (the builder)",
      "back\\slash",
      new Date("2024-01-01T00:00:00.000Z"),
      new Date("2024-06-15T12:30:00.000Z"),
      "plain",
      "another, one",
    ]
    const options: LoadSubsetOptions = { where: inArray(id, values) }
    const maxUrlLength = BASE_URL.length + 60
    const chunks = split(options, maxUrlLength)

    expect(chunks.length).toBeGreaterThan(1)
    expectEveryChunkFits(chunks, maxUrlLength)
    expect(new Set(inValuesFor(chunks, ["id"]))).toEqual(new Set(values))
  })

  test("the union of chunk values equals the deduped, null-free input", () => {
    const values = [1, 2, 3, null, 2, 4, 5, null, 6, 7, 8, 9, 10]
    const options: LoadSubsetOptions = { where: inArray(id, values) }
    const maxUrlLength = BASE_URL.length + 30
    const chunks = split(options, maxUrlLength)

    expect(chunks.length).toBeGreaterThan(1)
    expectEveryChunkFits(chunks, maxUrlLength)
    const expected = new Set(values.filter((v) => v != null))
    expect(new Set(inValuesFor(chunks, ["id"]))).toEqual(expected)
  })

  test("leaves a top-level not(in) unsplit", () => {
    const values = Array.from({ length: 200 }, (_, i) => `id-${i}`)
    const options: LoadSubsetOptions = { where: not(inArray(id, values)) }
    const result = split(options, BASE_URL.length + 20)
    expect(result).toEqual([options])
    expect(result[0]).toBe(options)
  })

  test("leaves an IN nested inside OR unsplit", () => {
    const values = Array.from({ length: 200 }, (_, i) => `id-${i}`)
    const options: LoadSubsetOptions = {
      where: or(inArray(id, values), eq(active, true)),
    }
    const result = split(options, BASE_URL.length + 20)
    expect(result).toEqual([options])
    expect(result[0]).toBe(options)
  })

  test("an unsplittable subset (no where) returns [options] unchanged", () => {
    // Nothing to split, yet still "too long" per the fake budget: the
    // splitter must not loop or throw, just hand the request back as-is.
    const options: LoadSubsetOptions = {}
    const result = split(options, -1)
    expect(result).toEqual([options])
    expect(result[0]).toBe(options)
  })

  describe("limit/offset/cursor rewriting", () => {
    const values = Array.from({ length: 100 }, (_, i) => i)

    test("keeps limit unchanged and does not touch offset when a cursor is present", () => {
      const options: LoadSubsetOptions = {
        where: inArray(id, values),
        limit: 20,
        cursor: { whereFrom: gt(id, 5), whereCurrent: eq(id, 5) },
      }
      const chunks = split(options, BASE_URL.length + 20)

      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.limit).toBe(20)
        expect(chunk.cursor).toBe(options.cursor)
      }
    })

    test("folds offset into limit and drops offset when there is no cursor", () => {
      const options: LoadSubsetOptions = {
        where: inArray(id, values),
        limit: 10,
        offset: 5,
      }
      const chunks = split(options, BASE_URL.length + 20)

      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.limit).toBe(15)
        expect(chunk.offset).toBeUndefined()
      }
    })

    test("drops offset without adding a limit when the caller had none", () => {
      const options: LoadSubsetOptions = {
        where: inArray(id, values),
        offset: 5,
      }
      const chunks = split(options, BASE_URL.length + 20)

      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.limit).toBeUndefined()
        expect(chunk.offset).toBeUndefined()
      }
    })
  })

  test("recurses into the next-largest IN when the largest alone cannot shrink enough", () => {
    const idValues = Array.from({ length: 60 }, (_, i) => `id-${i}`)
    const otherValues = Array.from({ length: 60 }, (_, i) => `other-${i}`)
    const options: LoadSubsetOptions = {
      where: and(inArray(id, idValues), inArray(other, otherValues)),
    }
    // Small enough that even a single `id` value alongside the full `other`
    // list does not fit, forcing a split of `other` first.
    const maxUrlLength = BASE_URL.length + 80
    const chunks = split(options, maxUrlLength)

    expect(chunks.length).toBeGreaterThan(1)
    expectEveryChunkFits(chunks, maxUrlLength)
    expect(new Set(inValuesFor(chunks, ["id"]))).toEqual(new Set(idValues))
    expect(new Set(inValuesFor(chunks, ["other"]))).toEqual(
      new Set(otherValues)
    )

    // Every original (id, other) pair is covered by exactly one chunk's
    // cartesian product, and chunks stay disjoint on both split columns.
    const pairs = new Set<string>()
    for (const chunk of chunks) {
      const chunkIds = inValuesFor([chunk], ["id"])
      const chunkOthers = inValuesFor([chunk], ["other"])
      for (const a of chunkIds) {
        for (const b of chunkOthers) {
          pairs.add(`${a}|${b}`)
        }
      }
    }
    expect(pairs.size).toBe(idValues.length * otherValues.length)
    // Disjoint: no pair is fetched by more than one chunk.
    const chunkPairCount = chunks.reduce(
      (sum, chunk) =>
        sum +
        inValuesFor([chunk], ["id"]).length *
          inValuesFor([chunk], ["other"]).length,
      0
    )
    expect(chunkPairCount).toBe(pairs.size)
  })

  test("shrinks the next-largest IN against a single value of the largest, not its full list", () => {
    const idValues = Array.from({ length: 300 }, (_, i) => `id-${i}`)
    const otherValues = Array.from({ length: 300 }, (_, i) => `other-${i}`)
    const options: LoadSubsetOptions = {
      where: and(inArray(id, idValues), inArray(other, otherValues)),
    }
    // Neither full list fits alongside the other, but half of `other` does.
    // Measuring `other`'s split against the full `id` list would shrink it to
    // one value per chunk (~600 requests); measuring against one `id` value
    // keeps it to a handful of `other` slices.
    const maxUrlLength = BASE_URL.length + 2000
    const chunks = split(options, maxUrlLength)

    expectEveryChunkFits(chunks, maxUrlLength)
    expect(new Set(inValuesFor(chunks, ["id"]))).toEqual(new Set(idValues))
    expect(new Set(inValuesFor(chunks, ["other"]))).toEqual(
      new Set(otherValues)
    )
    expect(chunks.length).toBeLessThan(150)
  })
})
