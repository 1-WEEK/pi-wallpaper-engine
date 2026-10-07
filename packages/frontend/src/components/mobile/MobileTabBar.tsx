// TabBar (mobile spec §3.2): the rail's mobile degradation. The selected
// tab = resident inverted block (--pt-inv-bg, square, inset 8/4 of the
// cell) that migrates in 250ms --ease-slide; during the flight a rAF
// coverWatch flips any cell >30% covered per frame so text never reads
// inverted-before-the-block. The amber top tick is abolished; the hot
// badge stays a chip face (status channel, readable on and off the block).
// Press vocabulary (§2.1): the pressed tab's dither survives release and
// is cleared only when the block lands (transitionend, 380ms fallback) —
// the sliding block physically covers it (03 D8).
// z 16 > MiniPlayer z 15: the bar is opaque and the tuck hides behind it.
import { useEffect, useRef, type ReactNode } from "react"
import { Link } from "wouter"
import type { SystemSummary } from "../../api.js"
import { appIcons } from "../../icons.js"
import { getActiveTaskCount } from "../../activeTaskCount.js"

interface TabItem {
  href: string
  label: string
  icon: ReactNode
  badge?: number
  hot?: boolean
}

interface Props {
  summary: SystemSummary | null
  currentLoc: string
  browseHref: string
}

const matches = (loc: string, href: string): boolean => {
  if (href === "/browse") return loc === "/" || loc === "/browse" || loc.startsWith("/browse?")
  return loc === href || loc.startsWith(`${href}?`) || loc.startsWith(`${href}/`)
}

export const MobileTabBar = ({ summary, currentLoc, browseHref }: Props) => {
  const totalActive = getActiveTaskCount(summary)
  const items: TabItem[] = [
    { href: browseHref, label: "Browse", icon: appIcons.browse },
    {
      href: "/library",
      label: "Library",
      icon: appIcons.library,
      badge: summary?.status.library.total,
    },
    {
      href: "/activity",
      label: "Activity",
      icon: appIcons.activity,
      badge: totalActive,
      hot: totalActive > 0,
    },
    { href: "/settings", label: "Settings", icon: appIcons.settings },
  ]

  const cellsRef = useRef<HTMLDivElement | null>(null)
  const blockRef = useRef<HTMLDivElement | null>(null)
  const covRafRef = useRef(0)
  const fallbackRef = useRef(0)
  const measuredRef = useRef(false)

  const activeIndex = items.findIndex((it) =>
    matches(currentLoc, it.href === browseHref ? "/browse" : it.href)
  )

  useEffect(() => {
    const cells = cellsRef.current
    const block = blockRef.current
    if (!cells || !block || activeIndex < 0) return
    const tabs = [...cells.querySelectorAll<HTMLElement>(".mobile-tab-bar-item")]
    const cellW = cells.offsetWidth / items.length
    if (cellW === 0) return

    const done = () => {
      cancelAnimationFrame(covRafRef.current)
      clearTimeout(fallbackRef.current)
      tabs.forEach((t) => {
        t.classList.remove("covered")
        // 03 D8: the press dither outlives release and dies exactly when
        // the block lands — a 0ms cut, no transition.
        t.classList.add("cut")
        t.classList.remove("pressing")
        void t.offsetWidth
        t.classList.remove("cut")
      })
    }

    // First layout: place the block under the active cell without a
    // migration animation; later moves animate (250ms --ease-slide).
    if (!measuredRef.current) {
      measuredRef.current = true
      block.classList.add("noanim")
      block.style.width = `${cellW - 16}px`
      block.style.transform = `translateX(${activeIndex * cellW}px)`
      void block.offsetWidth
      block.classList.remove("noanim")
      done()
      return
    }

    block.style.width = `${cellW - 16}px`
    block.style.transform = `translateX(${activeIndex * cellW}px)`

    const pressed = cells.querySelector<HTMLElement>(".mobile-tab-bar-item.pressing")
    const tick = () => {
      const br = block.getBoundingClientRect()
      tabs.forEach((tab) => {
        if (tab === pressed) return
        const r = tab.getBoundingClientRect()
        const overlap = Math.max(0, Math.min(br.right, r.right) - Math.max(br.left, r.left))
        tab.classList.toggle("covered", overlap / r.width > 0.3 && overlap > 4)
      })
      covRafRef.current = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(covRafRef.current)
    covRafRef.current = requestAnimationFrame(tick)
    block.addEventListener("transitionend", done, { once: true })
    clearTimeout(fallbackRef.current)
    fallbackRef.current = window.setTimeout(done, 380)
    return () => {
      block.removeEventListener("transitionend", done)
      cancelAnimationFrame(covRafRef.current)
      clearTimeout(fallbackRef.current)
    }
  }, [activeIndex, items.length])

  return (
    <nav className="mobile-tab-bar" aria-label="Primary">
      <div className="mobile-tab-bar-cells" ref={cellsRef}>
        <div className="mobile-tab-bar-block" ref={blockRef} aria-hidden="true" />
        {items.map((it) => {
          const active = matches(currentLoc, it.href === browseHref ? "/browse" : it.href)
          return (
            <Link
              key={it.label}
              href={it.href}
              data-press="tab"
              data-nav={it.label.toLowerCase()}
              className={`mobile-tab-bar-item ${active ? "active" : ""}`}
            >
              <span className="mobile-tab-bar-icon">
                {it.icon}
                {it.badge !== undefined && it.badge > 0 && (
                  <span
                    className={`mobile-tab-bar-badge mono ${it.hot ? "hot" : ""}`}
                    aria-label={`${it.badge}`}
                  >
                    {it.badge}
                  </span>
                )}
              </span>
              <span className="mobile-tab-bar-label">{it.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
