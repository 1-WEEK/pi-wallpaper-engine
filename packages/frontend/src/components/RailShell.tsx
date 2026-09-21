// RailShell — the global instrument rail of the redesign (spec §2.3 / §3.1).
// 300px sticky column, top to bottom: typographic wordmark → plain-text nav
// (no numbering, no §; the active item wears a plain inverse fill until
// ticket 11 upgrades it to the XOR mask sweep) → per-page control slot →
// THEME tri-state at the bottom. No PI.LOCAL, no live clock (05 修正).
import { createContext, useContext, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Link } from "wouter"
import type { SystemSummary } from "@pwe/shared"
import { getActiveTaskCount } from "../activeTaskCount.js"
import { useTheme, type ThemeChoice } from "../theme.js"

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
  const activityCount = getActiveTaskCount(summary)

  const navItems: ReadonlyArray<{ href: string; label: string; active: boolean; count?: number }> = [
    { href: browseHref, label: "Browse", active: loc === "/browse" || loc === "/" },
    { href: "/library", label: "Library", active: loc === "/library" },
    {
      href: "/activity",
      label: "Activity",
      active: loc === "/activity",
      count: activityCount,
    },
    { href: "/settings", label: "Settings", active: loc === "/settings" },
  ]

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

        <nav className="rail-nav">
          {navItems.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className={`rail-nav-link ${item.active ? "is-here" : ""}`}
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
