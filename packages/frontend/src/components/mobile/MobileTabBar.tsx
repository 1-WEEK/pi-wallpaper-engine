import type { ReactNode } from "react"
import { Link } from "wouter"
import type { SystemSummary } from "../../api.js"
import { appIcons } from "../../icons.js"

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
  const dlActive = summary?.status.downloads.active ?? 0
  const items: TabItem[] = [
    { href: browseHref, label: "Browse", icon: appIcons.browse },
    {
      href: "/library",
      label: "Library",
      icon: appIcons.library,
      badge: summary?.status.library.total,
    },
    {
      href: "/downloads",
      label: "Downloads",
      icon: appIcons.downloads,
      badge: dlActive,
      hot: dlActive > 0,
    },
    { href: "/settings", label: "Settings", icon: appIcons.settings },
  ]
  return (
    <nav className="mobile-tab-bar" aria-label="Primary">
      {items.map((it) => {
        const active = matches(currentLoc, it.href === browseHref ? "/browse" : it.href)
        return (
          <Link
            key={it.label}
            href={it.href}
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
    </nav>
  )
}
