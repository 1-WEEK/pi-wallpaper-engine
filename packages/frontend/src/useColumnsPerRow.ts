import { useLayoutEffect, useState } from "react"
import type { RefObject } from "react"

/**
 * Pure computation: how many grid columns fit in a container of the given width.
 *
 * Mirrors what CSS `auto-fill, minmax(M, 1fr)` resolves:
 *   columns = floor((containerWidth + gap) / (minCardWidth + gap))
 */
export const computeFitColumns = (
  containerWidth: number,
  minCardWidth: number,
  gap: number
): number => Math.max(1, Math.floor((containerWidth + gap) / (minCardWidth + gap)))

/**
 * Tracks how many grid columns fit in a container at the current width.
 */
export const useColumnsPerRow = (
  ref: RefObject<HTMLElement | null>,
  minCardWidth: number,
  gap: number
): number => {
  const [columns, setColumns] = useState<number>(() => {
    if (typeof window === "undefined") return 4
    // Best-effort initial guess before ResizeObserver fires
    const w = Math.max(320, window.innerWidth - 260) // 260 is about the sidebar width
    return computeFitColumns(w, minCardWidth, gap)
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setColumns(computeFitColumns(entry.contentRect.width, minCardWidth, gap))
    })

    ro.observe(el)
    return () => ro.disconnect()
  }, [minCardWidth, gap, ref])

  return columns
}
