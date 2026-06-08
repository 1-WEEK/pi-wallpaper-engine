import { describe, expect, test } from "bun:test"
import { advanceIndex, buildSequence, shuffleSequence } from "./Rotation.js"

describe("advanceIndex", () => {
  test("returns -1 for an empty sequence", () => {
    expect(advanceIndex(0, 0, 1)).toBe(-1)
    expect(advanceIndex(3, 0, -1)).toBe(-1)
  })

  test("advances forward with wraparound", () => {
    expect(advanceIndex(2, 5, 1)).toBe(3)
    expect(advanceIndex(4, 5, 1)).toBe(0)
  })

  test("advances backward with wraparound", () => {
    expect(advanceIndex(2, 5, -1)).toBe(1)
    expect(advanceIndex(0, 5, -1)).toBe(4)
  })

  test("treats a -1 current index as before-the-start", () => {
    expect(advanceIndex(-1, 5, 1)).toBe(0)
  })
})

describe("buildSequence", () => {
  const ids = ["a", "b", "c", "d"]

  test("sequential and single keep library order in a fresh array", () => {
    expect(buildSequence(ids, "sequential")).toEqual(ids)
    expect(buildSequence(ids, "single")).toEqual(ids)
    // a copy, not the same reference, so callers can mutate freely
    expect(buildSequence(ids, "sequential")).not.toBe(ids)
  })

  test("shuffle returns a permutation of the same ids", () => {
    const out = buildSequence(ids, "shuffle", () => 0)
    expect([...out].sort()).toEqual([...ids].sort())
    // deterministic Fisher-Yates with rng()=>0
    expect(out).toEqual(["b", "c", "d", "a"])
  })
})

describe("shuffleSequence", () => {
  test("does not mutate the input and preserves all elements", () => {
    const input = ["x", "y", "z"]
    const out = shuffleSequence(input, () => 0)
    expect(input).toEqual(["x", "y", "z"])
    expect([...out].sort()).toEqual(["x", "y", "z"])
  })

  test("handles empty and single-element arrays", () => {
    expect(shuffleSequence([], () => 0)).toEqual([])
    expect(shuffleSequence(["solo"], () => 0)).toEqual(["solo"])
  })
})
