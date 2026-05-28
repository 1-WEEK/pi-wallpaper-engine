import { useEffect, useRef } from "react"
import type { CSSProperties, ReactNode } from "react"
import { Link, Redirect, Route, Switch, useLocation, useSearch } from "wouter"
import useSWR from "swr"
import { SWRConfig, useSWRConfig } from "swr"
import { api, onAuthChange } from "./api.js"
import type { SystemSummary } from "./api.js"
import { fetchSession, fetchSetupState } from "./auth.js"
import { appIcons } from "./icons.js"
import { Browse } from "./pages/Browse.js"
import { Downloads } from "./pages/Downloads.js"
import { Library } from "./pages/Library.js"
import { Login } from "./pages/Login.js"
import { Setup } from "./pages/Setup.js"
import { Settings } from "./pages/Settings.js"
import { PlayerBar } from "./components/PlayerBar.js"
import {
  LayoutProvider,
  MobileMiniPlayer,
  MobileTabBar,
  MobileTopBar,
  useContainerWidth,
  useLayout,
} from "./components/mobile/index.js"

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

const Routes = ({
  summary,
  onRefresh,
}: {
  summary: SystemSummary | undefined
  onRefresh: () => void
}) => (
  <Switch>
    <Route path="/browse">
      <Browse />
    </Route>
    <Route path="/library">
      <Library
        nowPlayingId={summary?.status.player.current_workshop_id ?? null}
        onSystemRefresh={onRefresh}
      />
    </Route>
    <Route path="/downloads">
      <Downloads />
    </Route>
    <Route path="/settings">
      <Settings summary={summary ?? null} onRefresh={onRefresh} />
    </Route>
    <Route>
      <Redirect to="/browse" />
    </Route>
  </Switch>
)

const pageTitle = (loc: string): string => {
  if (loc.startsWith("/library")) return "Library"
  if (loc.startsWith("/downloads")) return "Downloads"
  if (loc.startsWith("/settings")) return "Settings"
  return "Browse"
}

const ShellBody = () => {
  const [loc] = useLocation()
  const search = useSearch()
  const savedBrowseSearch = useRef("")
  const { mobile } = useLayout()
  const { data: summary, mutate: mutateSummary } = useSWR("system-summary", api.systemSummary, {
    refreshInterval: 5000,
    revalidateIfStale: true,
  })

  const browseActive = loc === "/browse" || loc === "/"
  if (browseActive) savedBrowseSearch.current = search

  const refresh = () => {
    void mutateSummary()
  }

  const browseHref = savedBrowseSearch.current
    ? `/browse?${savedBrowseSearch.current}`
    : "/browse"

  if (mobile) {
    return (
      <>
        <MobileTopBar title={pageTitle(loc)} summary={summary ?? null} />
        <main className="mobile-main">
          <Routes summary={summary} onRefresh={refresh} />
        </main>
        <MobileMiniPlayer summary={summary ?? null} onRefresh={refresh} />
        <MobileTabBar
          summary={summary ?? null}
          currentLoc={loc}
          browseHref={browseHref}
        />
      </>
    )
  }

  return (
    <DesktopShell
      summary={summary ?? null}
      loc={loc}
      browseHref={browseHref}
      browseActive={browseActive}
      onRefresh={refresh}
    />
  )
}

const DesktopShell = ({
  summary,
  loc,
  browseHref,
  browseActive,
  onRefresh,
}: {
  summary: SystemSummary | null
  loc: string
  browseHref: string
  browseActive: boolean
  onRefresh: () => void
}) => {
  const screen = summary?.config.screen
  const display = summary?.status.display
  const storage = summary?.status.storage
  const player = summary?.status.player
  const storageUsage = storage
    ? formatStorageUsage(storage.used_bytes, storage.total_bytes)
    : "Loading…"
  const displayStateLabel = display ? (display.configured ? display.state : "disabled") : "Loading…"
  const displayStateTone =
    display && display.configured && display.state === "on"
      ? "on"
      : display && (display.state === "off" || !display.configured)
        ? "off"
        : "unknown"

  const navItems: ReadonlyArray<{
    href: string
    active: boolean
    label: string
    icon: ReactNode
    badge?: number
  }> = [
    {
      href: browseHref,
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
    <>
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
          {storage?.available === false && (storage.last_error || storage.error) && (
            <div className="sidebar-status-note">{storage.last_error ?? storage.error}</div>
          )}
        </div>
      </aside>

      <main className="main">
        <Routes summary={summary ?? undefined} onRefresh={onRefresh} />
      </main>

      <PlayerBar summary={summary} onRefresh={onRefresh} />
    </>
  )
}

const AppShell = () => {
  const [ref, width] = useContainerWidth()
  const mobile = width > 0 && width < 720
  return (
    <div ref={ref} className={mobile ? "mobile-shell" : "app"}>
      <LayoutProvider width={width}>
        <ShellBody />
      </LayoutProvider>
    </div>
  )
}

const AuthGate = () => {
  const { mutate } = useSWRConfig()
  const {
    data: setupState,
    isLoading: setupLoading,
    error: setupError,
    mutate: refetchSetup,
  } = useSWR("auth-setup-state", fetchSetupState)
  const { data: session, isLoading: sessionLoading, mutate: refetchSession } = useSWR(
    setupState?.enabled ? "auth-session" : null,
    fetchSession
  )

  useEffect(() => {
    const off = onAuthChange(() => {
      void refetchSession()
      void refetchSetup()
      // Trigger an immediate revalidation on every non-auth cache key. We pass
      // no data argument so SWR keeps the old (often errored) value visible
      // until the new fetch returns — the alternative,
      // `mutate(..., undefined, { revalidate: false })`, wipes the cache to
      // `undefined` and then nothing refetches because the previous fetch
      // sits inside the 60s dedup window and blocks the 5s refreshInterval
      // tick, leaving PlayerBar stuck on "Connecting to Pi…" until the user
      // reloads.
      void mutate((key) => typeof key === "string" && !key.startsWith("auth-"))
    })
    return off
  }, [mutate, refetchSession, refetchSetup])

  if (setupLoading || (setupState?.enabled && sessionLoading)) {
    return <div className="auth-shell" />
  }

  // Fail closed: distinguish a true backend failure (setupError set) from a
  // transient undefined cache during refetch. Only the former should escalate
  // to the error UI.
  if (setupError) {
    return (
      <div className="auth-shell auth-shell-error">
        <h1>Backend unreachable</h1>
        <p>
          Could not load authentication state from <code>/api/auth/setup-state</code>.
          Check that the backend is running and the dev proxy points to the right port.
        </p>
        <button type="button" onClick={() => void refetchSetup()}>
          Retry
        </button>
      </div>
    )
  }

  if (!setupState) {
    return <div className="auth-shell" />
  }

  if (!setupState.enabled) {
    return <AppShell />
  }

  if (!setupState.setup_complete) {
    return <Setup />
  }

  if (!session) {
    return <Login />
  }

  return <AppShell />
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
    <AuthGate />
  </SWRConfig>
)
