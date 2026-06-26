import { describe, expect, test } from "bun:test"
import { computeFitColumns } from "./useColumnsPerRow.js"

// Same constants used in Browse.tsx
const MIN_CARD_WIDTH = 248
const GRID_GAP = 14

describe("computeFitColumns", () => {
  test("returns at least 1 for any positive width", () => {
    expect(computeFitColumns(1, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(100, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(200, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
  })

  test("single column at minCardWidth boundary", () => {
    // One card exactly fits, no room for a second
    expect(computeFitColumns(248, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(248 + 14, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    // Room for exactly two cards
    expect(computeFitColumns(248 * 2 + 14, MIN_CARD_WIDTH, GRID_GAP)).toBe(2)
  })

  test("known columns at specific widths (1280px content area)", () => {
    // Container width is about 1280 - 228 (sidebar) - 40 (main padding) = 1012px
    // columns = floor((1012 + 14) / (248 + 14)) = floor(1026/262) = floor(3.92) = 3
    expect(computeFitColumns(1012, MIN_CARD_WIDTH, GRID_GAP)).toBe(3)
  })

  test("known columns at wider content area (1600px viewport)", () => {
    // Container width is about 1600 - 228 - 40 = 1332px
    // columns = floor((1332 + 14) / 262) = floor(5.13) = 5
    expect(computeFitColumns(1332, MIN_CARD_WIDTH, GRID_GAP)).toBe(5)
  })

  test("known columns at 1920px viewport", () => {
    // Container width is about 1920 - 228 - 40 = 1652px
    // columns = floor((1652 + 14) / 262) = floor(6.35) = 6
    expect(computeFitColumns(1652, MIN_CARD_WIDTH, GRID_GAP)).toBe(6)
  })

  test("pageSize multiples: ceil(25/col) * col at various column counts", () => {
    const PAGE_SIZE = 25
    // 3 cols: ceil(25/3)*3 = 27. 27 % 3 = 0
    expect(Math.ceil(PAGE_SIZE / 3) * 3).toBe(27)
    expect(27 % 3).toBe(0)

    // 4 cols: ceil(25/4)*4 = 28. 28 % 4 = 0
    expect(Math.ceil(PAGE_SIZE / 4) * 4).toBe(28)
    expect(28 % 4).toBe(0)

    // 5 cols: ceil(25/5)*5 = 25. 25 % 5 = 0
    expect(Math.ceil(PAGE_SIZE / 5) * 5).toBe(25)
    expect(25 % 5).toBe(0)

    // 6 cols: ceil(25/6)*6 = 30. 30 % 6 = 0
    expect(Math.ceil(PAGE_SIZE / 6) * 6).toBe(30)
    expect(30 % 6).toBe(0)

    // 7 cols: ceil(25/7)*7 = 28. 28 % 7 = 0
    expect(Math.ceil(PAGE_SIZE / 7) * 7).toBe(28)
    expect(28 % 7).toBe(0)

    // 8 cols: ceil(25/8)*8 = 32. 32 % 8 = 0
    expect(Math.ceil(PAGE_SIZE / 8) * 8).toBe(32)
    expect(32 % 8).toBe(0)
  })

  test("minCardWidth and gap can be varied", () => {
    // Smaller card = more columns
    expect(computeFitColumns(1000, 150, 10)).toBeGreaterThan(computeFitColumns(1000, 300, 10))
    // Larger gap = fewer columns
    expect(computeFitColumns(1000, 200, 5)).toBeGreaterThanOrEqual(
      computeFitColumns(1000, 200, 25)
    )
  })
})
