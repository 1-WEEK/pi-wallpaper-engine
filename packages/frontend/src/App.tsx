import { useRef } from "react"
import type { CSSProperties } from "react"
import type { ReactNode } from "react"
import { Link, Redirect, Route, Switch, useLocation, useSearch } from "wouter"
import useSWR from "swr"
import { SWRConfig } from "swr"
import { api } from "./api.js"
import { appIcons } from "./icons.js"
import { Browse } from "./pages/Browse.js"
import { Downloads } from "./pages/Downloads.js"
import { Library } from "./pages/Library.js"
import { Settings } from "./pages/Settings.js"
import { PlayerBar } from "./components/PlayerBar.js"

const formatStorageUsage = (
  usedBytes: number | null | undefined,
  totalBytes: number | null | undefined
): string => {
  if (usedBytes === null || usedBytes === undefined || totalBytes === null || totalBytes === undefined) {
    return "Unavailable"
  }
  const used = usedBytes / (1024 * 1024 * 1024)
  const total = totalBytes / (1024 * 1024 * 1024)
  return `${used.toFixed(1)} / ${total.toFixed(1)} GB`
}

const ShellNavLink = ({
  href,
  label,
  icon,
  badge,
  active,
}: {
  href: string
  label: string
  icon: ReactNode
  badge?: number
  active?: boolean
}) => {
  return (
    <Link href={href} className={`sidebar-link ${active ? "active" : ""}`}>
      <span className="sidebar-link-icon">{icon}</span>
      <span className="sidebar-link-label">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className={`sidebar-badge ${href === "/downloads" ? "hot" : ""}`}>{badge}</span>
      )}
    </Link>
  )
}

const AppShell = () => {
  const [loc] = useLocation()
  const search = useSearch()
  const savedBrowseSearch = useRef("")
  const { data: summary, mutate: mutateSummary } = useSWR("system-summary", api.systemSummary, {
    refreshInterval: 5000,
    revalidateIfStale: true,
  })

  const screen = summary?.config.screen
  const display = summary?.status.display
  const storage = summary?.status.storage
  const player = summary?.status.player
  const storageUsage = storage
    ? formatStorageUsage(storage.used_bytes, storage.total_bytes)
    : "Loading…"
  const browseActive = loc === "/browse" || loc === "/"
  const displayStateLabel = display ? (display.configured ? display.state : "disabled") : "Loading…"
  const displayStateTone =
    display && display.configured && display.state === "on"
      ? "on"
      : display && (display.state === "off" || !display.configured)
        ? "off"
        : "unknown"

  if (browseActive) savedBrowseSearch.current = search

  const navItems: ReadonlyArray<{
    href: string
    active: boolean
    label: string
    icon: ReactNode
    badge?: number
  }> = [
    {
      href: savedBrowseSearch.current ? `/browse?${savedBrowseSearch.current}` : "/browse",
      active: browseActive,
      label: "Browse",
      icon: appIcons.browse,
    },
    {
      href: "/library",
      active: loc === "/library",
      label: "Library",
      icon: appIcons.library,
      badge: summary?.status.library.total,
    },
    {
      href: "/downloads",
      active: loc === "/downloads",
      label: "Downloads",
      icon: appIcons.downloads,
      badge: summary?.status.downloads.active,
    },
    {
      href: "/settings",
      active: loc === "/settings",
      label: "Settings",
      icon: appIcons.settings,
    },
  ]

  const activeNavIndex = navItems.findIndex((item) => item.active)
  const navStyle =
    activeNavIndex >= 0
      ? ({ "--sidebar-active-index": String(activeNavIndex) } as CSSProperties)
      : undefined

  return (
    <div className="app">
      <aside className="shell-sidebar">
        <div className="sidebar-brand">
          <img src="/favicon.svg" alt="" className="sidebar-logo" width={40} height={40} />
          <div className="sidebar-brand-copy">
            <div className="sidebar-brand-title">Pi Wallpaper Engine</div>
            <div className="sidebar-brand-subtitle mono">v0.1.0 · pi.local</div>
          </div>
        </div>
        <nav className="sidebar-nav" style={navStyle}>
          {activeNavIndex >= 0 && <span className="sidebar-nav-highlight" aria-hidden="true" />}
          {navItems.map((item) => (
            <ShellNavLink
              key={item.label}
              href={item.href}
              active={item.active}
              label={item.label}
              icon={item.icon}
              badge={item.badge}
            />
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="sidebar-status-title mono">Pi status</div>
          <div className="sidebar-status-row">
            <span>screen</span>
            <span className="mono">{screen ? `${screen.width}×${screen.height}` : "Loading…"}</span>
          </div>
          <div className="sidebar-status-row">
            <span>player</span>
            <span className="mono">
              {player ? (player.playing ? "playing" : player.current_workshop_id ? "paused" : "idle") : "Loading…"}
            </span>
          </div>
          <div className="sidebar-status-row">
            <span>display</span>
            <span className={`mono sidebar-status-value sidebar-status-value-${displayStateTone}`}>
              <span className="sidebar-status-indicator" aria-hidden="true" />
              {displayStateLabel}
            </span>
          </div>
          <div className="sidebar-status-row">
            <span>storage</span>
            <span className="mono">{storageUsage}</span>
          </div>
          {storage?.available === false && storage.error && (
            <div className="sidebar-status-note">{storage.error}</div>
          )}
        </div>
      </aside>

      <main className="main">
        <Switch>
          <Route path="/browse">
            <Browse />
          </Route>
          <Route path="/library">
            <Library
              nowPlayingId={summary?.status.player.current_workshop_id ?? null}
              onSystemRefresh={() => {
                void mutateSummary()
              }}
            />
          </Route>
          <Route path="/downloads">
            <Downloads />
          </Route>
          <Route path="/settings">
            <Settings summary={summary ?? null} />
          </Route>
          <Route>
            <Redirect to="/browse" />
          </Route>
        </Switch>
      </main>

      <PlayerBar
        summary={summary ?? null}
        onRefresh={() => {
          void mutateSummary()
        }}
      />
    </div>
  )
}

export const App = () => (
  <SWRConfig
    value={{
      revalidateOnFocus: false,
      revalidateIfStale: false,
      dedupingInterval: 60_000,
      shouldRetryOnError: false,
    }}
  >
    <AppShell />
  </SWRConfig>
)
