import { useLayoutEffect, useState } from "react"
import type { RefObject } from "react"

/**
 * Tracks how many grid columns fit in a container at the current width.
 *
 * The calculation mirrors what CSS `auto-fill, minmax(M, 1fr)` resolves:
 *   columns = floor((containerWidth + gap) / (minCardWidth + gap))
 *
 * @param ref - ref attached to the grid container
 * @param minCardWidth - the `minmax(M, ...)` minimum, pixels
 * @param gap - `gap` value, pixels
 * @returns number of columns that fit (>= 1)
 */
export const useColumnsPerRow = (
  ref: RefObject<HTMLElement | null>,
  minCardWidth: number,
  gap: number
): number => {
  const [columns, setColumns] = useState<number>(() => {
    if (typeof window === "undefined") return 4
    // Best-effort initial guess before ResizeObserver fires
    const w = Math.max(320, window.innerWidth - 260) // 260 ≈ sidebar width
    return Math.max(1, Math.floor((w + gap) / (minCardWidth + gap)))
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const w = entry.contentRect.width
      setColumns(Math.max(1, Math.floor((w + gap) / (minCardWidth + gap))))
    })

    ro.observe(el)
    return () => ro.disconnect()
  }, [minCardWidth, gap, ref])

  return columns
}
