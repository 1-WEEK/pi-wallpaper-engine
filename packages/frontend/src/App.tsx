import { useRef } from "react"
import { Link, Redirect, Route, Switch, useLocation, useSearch } from "wouter"
import { SWRConfig } from "swr"
import { Browse } from "./pages/Browse.js"
import { Downloads } from "./pages/Downloads.js"
import { Library } from "./pages/Library.js"
import { Settings } from "./pages/Settings.js"
import { PlayerBar } from "./components/PlayerBar.js"

const NavLink = ({ href, label }: { href: string; label: string }) => {
  const [loc] = useLocation()
  const search = useSearch()
  const savedSearch = useRef("")
  const isBrowse = href === "/browse"
  const active = loc === href || (isBrowse && loc === "/")

  if (isBrowse && active) savedSearch.current = search

  const targetHref = isBrowse && savedSearch.current
    ? `/browse?${savedSearch.current}`
    : href

  return (
    <Link href={targetHref} className={active ? "active" : ""}>
      {label}
    </Link>
  )
}

export const App = () => {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateIfStale: false,
        dedupingInterval: 60_000,
        shouldRetryOnError: false,
      }}
    >
      <div className="app">
        <header className="header">
          <div className="header-brand">
            <img src="/favicon.svg" alt="" className="header-logo" width={32} height={32} />
            <h1>Pi Wallpaper Engine</h1>
          </div>
          <PlayerBar />
        </header>
        <nav className="nav">
          <NavLink href="/browse" label="Browse" />
          <NavLink href="/library" label="Library" />
          <NavLink href="/downloads" label="Downloads" />
          <NavLink href="/settings" label="Settings" />
        </nav>
        <main className="main">
          <Switch>
            <Route path="/browse"><Browse /></Route>
            <Route path="/library"><Library /></Route>
            <Route path="/downloads"><Downloads /></Route>
            <Route path="/settings"><Settings /></Route>
            <Route><Redirect to="/browse" /></Route>
          </Switch>
        </main>
      </div>
    </SWRConfig>
  )
}
