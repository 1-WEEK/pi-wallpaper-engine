// Measured coordinate grid — the design signature (spec §2.3). Vertical
// lines sit in the exact centers of the card-grid column gutters, horizontal
// lines in the row-gutter centers, and `+` registration marks where four
// cards meet. Geometry is measured from the rendered cards with offset
// properties only (transform-immune; getBoundingClientRect is banned here
// because ancestor transforms — e.g. the header parallax — would pollute
// viewport-space rects). A ResizeObserver on the grid recomputes on resize
// and on every append, so realignment is instant.
import { useEffect, useState, type RefObject } from "react"

interface CardBox {
  top: number
  left: number
  right: number
  bottom: number
}

interface GridMetrics {
  v: number[]
  h: number[]
}

const EMPTY: GridMetrics = { v: [], h: [] }

// Rows are uniform; a 4px tolerance absorbs integer rounding of offsetTop.
const ROW_TOLERANCE = 4

/** Accumulates offsetTop/offsetLeft up the offsetParent chain to `root`. */
const offsetWithin = (el: HTMLElement, root: HTMLElement): { top: number; left: number } => {
  let top = 0
  let left = 0
  let node: HTMLElement | null = el
  while (node && node !== root) {
    top += node.offsetTop
    left += node.offsetLeft
    node = node.offsetParent as HTMLElement | null
  }
  return { top, left }
}

export const measureContactGrid = (
  root: HTMLElement,
  grid: HTMLElement,
  cardSelector: string
): GridMetrics & { cardHeight: number | null } => {
  const cards = [...grid.querySelectorAll<HTMLElement>(cardSelector)]
  if (cards.length < 2) return { ...EMPTY, cardHeight: cards[0]?.offsetHeight ?? null }

  const boxes: CardBox[] = cards.map((card) => {
    const { top, left } = offsetWithin(card, root)
    return { top, left, right: left + card.offsetWidth, bottom: top + card.offsetHeight }
  })

  const byTop = [...boxes].sort((a, b) => a.top - b.top)
  const rows: CardBox[][] = []
  for (const box of byTop) {
    const row = rows[rows.length - 1]
    const rowHead = row?.[0]
    if (row && rowHead && Math.abs(rowHead.top - box.top) <= ROW_TOLERANCE) row.push(box)
    else rows.push([box])
  }

  // Column gutters come from the fullest row so a short final row can't
  // shift the vertical lines.
  const fullest = [...rows].sort((a, b) => b.length - a.length)[0]
  if (!fullest) return { ...EMPTY, cardHeight: cards[0]?.offsetHeight ?? null }
  const cols = [...fullest].sort((a, b) => a.left - b.left)
  const v: number[] = []
  for (let i = 0; i < cols.length - 1; i++) {
    const cur = cols[i]
    const next = cols[i + 1]
    if (!cur || !next) continue
    v.push((cur.right + next.left) / 2)
  }

  const h: number[] = []
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i]
    const nextRow = rows[i + 1]
    if (!row || !nextRow) continue
    const bottom = Math.max(...row.map((c) => c.bottom))
    const nextTop = Math.min(...nextRow.map((c) => c.top))
    h.push((bottom + nextTop) / 2)
  }

  const firstCard = cards[0]
  return { v, h, cardHeight: firstCard && firstCard.offsetHeight > 0 ? firstCard.offsetHeight : null }
}

export const GridOverlay = ({
  rootRef,
  gridRef,
  itemCount,
  cardSelector = ".bws-card",
  heightVar = "--bws-card-h",
}: {
  rootRef: RefObject<HTMLElement | null>
  gridRef: RefObject<HTMLElement | null>
  itemCount: number
  cardSelector?: string
  /** CSS variable on the root that receives the measured card height, feeding
   *  the cards' contain-intrinsic-height (spec §8.6). */
  heightVar?: string
}) => {
  const [metrics, setMetrics] = useState<GridMetrics>(EMPTY)

  useEffect(() => {
    const root = rootRef.current
    const grid = gridRef.current
    if (!root || !grid) return

    const compute = () => {
      const { cardHeight, ...next } = measureContactGrid(root, grid, cardSelector)
      // content-visibility engineering (spec §8.6): cards below the fold are
      // skipped by the renderer and sized by contain-intrinsic-height. The
      // contact sheet is uniform, so feeding back the measured card height
      // keeps offscreen rows (and therefore the measured gutters) exact
      // before those rows ever render.
      if (cardHeight) root.style.setProperty(heightVar, `${cardHeight}px`)
      setMetrics(next)
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [rootRef, gridRef, itemCount, cardSelector, heightVar])

  return (
    <div className="bws-gridlines" aria-hidden="true">
      {metrics.v.map((x) => (
        <span key={`v${x}`} className="bws-gl bws-gl-v" style={{ left: x }} />
      ))}
      {metrics.h.map((y) => (
        <span key={`h${y}`} className="bws-gl bws-gl-h" style={{ top: y }} />
      ))}
      {metrics.v.flatMap((x) =>
        metrics.h.map((y) => (
          <span key={`x${x}-${y}`} className="bws-gx mono" style={{ left: x, top: y }}>
            +
          </span>
        ))
      )}
    </div>
  )
}
