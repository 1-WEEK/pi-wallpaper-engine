// RailShell — the global instrument rail of the redesign (spec §2.3 / §3.1).
// 300px sticky column, top to bottom: typographic wordmark → plain-text nav
// (no numbering, no §; the active item wears a true XOR inversion mask —
// ticket 11, 09 票 N 方案) → per-page control slot → THEME tri-state at the
// bottom. No PI.LOCAL, no live clock (05 修正).
//
// Nav motion (ticket 11): one shared white mask in mix-blend-mode difference
// slides between items in 420ms on the symmetric --ease-slide (deliberately
// NOT --ease-out: that curve hits ~85% progress by one-third duration and
// would swallow the pass-over inversion). Everything mid-flight is driven by
// the mask's rectangle per frame (rAF): rows it overlaps (>30% of row
// height) brighten so the XOR reads near-black, and the clicked row's hover
// dither is clipped away in lockstep with the mask's leading edge. The
// target row's `is-covered` state flips only when the mask has fully
// settled. The route commit trails the indicator by 120ms (spec §3.1 跨页
// 联动) — deliberately NOT wrapped in a View Transition: a same-document VT
// freezes live DOM into static snapshots for its whole duration, which would
// stall the mask mid-slide and kill the per-frame pass-over inversion
// (verified against Chromium with .scratch/vt-probe). Reduced motion: the
// mask jumps, no slide, no delay — hover/active visuals are unchanged.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "wouter"
import type { SystemSummary } from "@pwe/shared"
import { getActiveTaskCount } from "../activeTaskCount.js"
import { useTheme, type ThemeChoice } from "../theme.js"
import { duration, easeSlide } from "../motionTokens.js"
import { prefersReducedMotion } from "../reducedMotion.js"

const RailControlsContext = createContext<HTMLElement | null>(null)

/** Portal slot for a page's own rail control sections (spec §3.1: 页级控制区).
 *  Pages render <RailControls>…</RailControls> anywhere under the shell. */
export const RailControls = ({ children }: { children: ReactNode }) => {
  const host = useContext(RailControlsContext)
  return host ? createPortal(children, host) : null
}

const THEME_OPTIONS: ReadonlyArray<{ choice: ThemeChoice; label: string }> = [
  { choice: "light", label: "[A]" },
  { choice: "dark", label: "[B]" },
  { choice: "auto", label: "[AUTO]" },
]

type NavKey = "browse" | "library" | "activity" | "settings"

export const RailShell = ({
  summary,
  loc,
  browseHref,
  children,
}: {
  summary: SystemSummary | null
  loc: string
  browseHref: string
  children: ReactNode
}) => {
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null)
  const { choice, setChoice } = useTheme()
  const [, navigate] = useLocation()
  const activityCount = getActiveTaskCount(summary)

  const navItems: ReadonlyArray<{
    key: NavKey
    href: string
    label: string
    active: boolean
    count?: number
  }> = [
    { key: "browse", href: browseHref, label: "Browse", active: loc === "/browse" || loc === "/" },
    { key: "library", href: "/library", label: "Library", active: loc === "/library" },
    {
      key: "activity",
      href: "/activity",
      label: "Activity",
      active: loc === "/activity",
      count: activityCount,
    },
    { key: "settings", href: "/settings", label: "Settings", active: loc === "/settings" },
  ]
  const activeKey = navItems.find((item) => item.active)?.key ?? null

  const navRef = useRef<HTMLElement | null>(null)
  const maskRef = useRef<HTMLDivElement | null>(null)
  const linkRefs = useRef<Partial<Record<NavKey, HTMLAnchorElement | null>>>({})
  // The mask's committed (underlying style) pose; its painted pose mid-flight
  // lives in the running WAAPI animation.
  const parkedRect = useRef<{ y: number; h: number } | null>(null)
  const flightKey = useRef<NavKey | null>(null)
  const flightTeardown = useRef<() => void>(() => {})
  const navCommitTimer = useRef<number | null>(null)
  // Physical coverage, trailing the mask: null while it slides, the target
  // key only once the mask has fully settled (spec §3.1).
  const [coveredKey, setCoveredKey] = useState<NavKey | null>(null)

  /** The mask's painted pose right now (in-flight transforms included),
   *  relative to the nav — re-triggering a flight resumes from this value
   *  instead of restarting from a stale target (same rule as §5 F4). */
  const presentedRect = (): { y: number; h: number } | null => {
    const mask = maskRef.current
    const nav = navRef.current
    if (!mask || !nav) return null
    const m = mask.getBoundingClientRect()
    const n = nav.getBoundingClientRect()
    return { y: m.top - n.top, h: m.height }
  }

  const flyTo = (key: NavKey, slide: boolean) => {
    const mask = maskRef.current
    const target = linkRefs.current[key]
    if (!mask || !target) return
    const toY = target.offsetTop
    const toH = target.offsetHeight
    flightTeardown.current()
    flightKey.current = null
    if (!slide) {
      mask.style.transform = `translateY(${toY}px)`
      mask.style.height = `${toH}px`
      parkedRect.current = { y: toY, h: toH }
      setCoveredKey(key)
      return
    }
    const from = presentedRect() ?? { y: toY, h: toH }
    setCoveredKey(null)
    flightKey.current = key
    const D = duration.ghostLong // 420ms — registered §5 exception (09 mask slide)
    const anim = mask.animate(
      [
        { transform: `translateY(${from.y}px)`, height: `${from.h}px` },
        { transform: `translateY(${toY}px)`, height: `${toH}px` },
      ],
      { duration: D, easing: easeSlide }
    )
    mask.style.transform = `translateY(${toY}px)`
    mask.style.height = `${toH}px`
    parkedRect.current = { y: toY, h: toH }

    const dirDown = toY >= from.y
    target.classList.add("is-sweeping")
    const links = Object.values(linkRefs.current).filter(
      (el): el is HTMLAnchorElement => el != null
    )
    let raf = 0
    // Per frame, straight from the mask's rect (never hand-timed): brighten
    // every row the mask overlaps by >30% of its height (passers-by included)
    // so the XOR inversion reads near-black, and clip the clicked row's hover
    // dither away in lockstep with the mask's leading edge — easing-agnostic,
    // so it can never drift out of alignment.
    const update = () => {
      // React rewrites className when the route commits mid-flight (is-here
      // moves), wiping imperative classes — re-assert them every frame.
      target.classList.add("is-sweeping")
      const m = mask.getBoundingClientRect()
      for (const link of links) {
        const r = link.getBoundingClientRect()
        const overlap = Math.min(m.bottom, r.bottom) - Math.max(m.top, r.top)
        link.classList.toggle("is-masked", overlap > r.height * 0.3)
      }
      const r = target.getBoundingClientRect()
      const p = Math.min(
        1,
        Math.max(0, dirDown ? (m.bottom - r.top) / r.height : (r.bottom - m.top) / r.height)
      )
      target.style.setProperty(
        "--pt-sweep",
        dirDown ? `inset(${p * 100}% 0 0 0)` : `inset(0 0 ${p * 100}% 0)`
      )
      raf = requestAnimationFrame(update)
    }
    raf = requestAnimationFrame(update)

    let done = false
    const teardownFlight = () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(fallback)
      anim.cancel()
      target.classList.remove("is-sweeping")
      target.style.removeProperty("--pt-sweep")
      links.forEach((link) => link.classList.remove("is-masked"))
      if (flightKey.current === key) flightKey.current = null
    }
    const settle = () => {
      if (done) return
      done = true
      teardownFlight()
      // Covered flips only now — the mask has fully landed.
      setCoveredKey(key)
    }
    // Safety net in case `finished` never settles (hidden tab throttling).
    const fallback = window.setTimeout(settle, D + 120)
    anim.finished.then(settle, () => {})
    flightTeardown.current = () => {
      if (done) return
      done = true
      teardownFlight()
    }
  }

  // Park the mask on the active item; slide when the route changed without a
  // click-started flight (back/forward, redirects). A flight started by the
  // click handler is already heading here — the 120ms content delay means the
  // route commits mid-flight — so it keeps ownership of the landing.
  useLayoutEffect(() => {
    if (!activeKey) return
    const target = linkRefs.current[activeKey]
    if (!target) return
    if (flightKey.current === activeKey) return
    const y = target.offsetTop
    const h = target.offsetHeight
    const parked = parkedRect.current
    const moved = parked === null || parked.y !== y || parked.h !== h
    flyTo(activeKey, parked !== null && moved && !prefersReducedMotion())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  useEffect(
    () => () => {
      flightTeardown.current()
      if (navCommitTimer.current !== null) window.clearTimeout(navCommitTimer.current)
    },
    []
  )

  const onNavClick = (e: ReactMouseEvent<HTMLAnchorElement>, item: (typeof navItems)[number]) => {
    // wouter has already let modified clicks (new tab etc.) through; take
    // over the plain left click. Clicking the current page is a no-op.
    e.preventDefault()
    if (item.active) return
    const target = linkRefs.current[item.key]
    if (!target || prefersReducedMotion()) {
      navigate(item.href)
      return
    }
    // Indicator first; the page content follows ~120ms later (spec §3.1).
    flyTo(item.key, true)
    navCommitTimer.current = window.setTimeout(() => navigate(item.href), duration.micro)
  }

  return (
    <RailControlsContext.Provider value={controlsHost}>
      <aside className="rail" data-lenis-prevent>
        <div className="rail-brand">
          <span className="rail-wordmark">
            pwe<sup className="rail-wordmark-mark">+</sup>
          </span>
          <span className="rail-brand-rule" aria-hidden="true" />
          <span className="rail-brand-note">PI WALLPAPER ENGINE</span>
        </div>

        <nav className="rail-nav" ref={navRef}>
          <div className="rail-nav-mask" ref={maskRef} aria-hidden="true" />
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`rail-nav-link ${item.active ? "is-here" : ""} ${
                coveredKey === item.key ? "is-covered" : ""
              }`}
              aria-current={item.active ? "page" : undefined}
              onClick={(e) => onNavClick(e, item)}
              ref={(el: HTMLAnchorElement | null) => {
                linkRefs.current[item.key] = el
              }}
            >
              <span className="rail-nav-label">{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="rail-nav-count">{item.count}</span>
              )}
            </Link>
          ))}
        </nav>

        <div className="rail-controls" ref={setControlsHost} />

        <div className="rail-foot">
          <span className="rail-label">THEME</span>
          <div className="rail-theme" role="group" aria-label="Theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.choice}
                type="button"
                className={`rail-theme-option ${choice === option.choice ? "is-on" : ""}`}
                aria-pressed={choice === option.choice}
                onClick={() => setChoice(option.choice)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {children}
    </RailControlsContext.Provider>
  )
}
