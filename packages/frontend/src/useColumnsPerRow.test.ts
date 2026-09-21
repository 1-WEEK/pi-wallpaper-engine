import { describe, expect, test } from "bun:test"
import { computeFitColumns } from "./useColumnsPerRow.js"

// Same constants used in Browse.tsx
const MIN_CARD_WIDTH = 248
const GRID_GAP = 16

describe("computeFitColumns", () => {
  test("returns at least 1 for any positive width", () => {
    expect(computeFitColumns(1, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(100, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(200, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
  })

  test("single column at minCardWidth boundary", () => {
    // One card exactly fits, no room for a second
    expect(computeFitColumns(248, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    expect(computeFitColumns(248 + 16, MIN_CARD_WIDTH, GRID_GAP)).toBe(1)
    // Room for exactly two cards
    expect(computeFitColumns(248 * 2 + 16, MIN_CARD_WIDTH, GRID_GAP)).toBe(2)
  })

  test("known columns at specific widths (1280px viewport)", () => {
    // Contact-sheet width is about 1280 - 300 (rail) - 40 (main padding)
    // - 64 (.bws padding) = 876px
    // columns = floor((876 + 16) / (248 + 16)) = floor(892/264) = 3
    expect(computeFitColumns(876, MIN_CARD_WIDTH, GRID_GAP)).toBe(3)
  })

  test("known columns at wider content area (1600px viewport)", () => {
    // Container width is about 1600 - 300 - 40 - 64 = 1196px
    // columns = floor((1196 + 16) / 264) = floor(4.59) = 4
    expect(computeFitColumns(1196, MIN_CARD_WIDTH, GRID_GAP)).toBe(4)
  })

  test("known columns at 1920px viewport", () => {
    // Container width is about 1920 - 300 - 40 - 64 = 1516px
    // columns = floor((1516 + 16) / 264) = floor(5.80) = 5
    expect(computeFitColumns(1516, MIN_CARD_WIDTH, GRID_GAP)).toBe(5)
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
