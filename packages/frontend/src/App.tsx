import { useState } from "react"
import { SWRConfig } from "swr"
import { Browse } from "./pages/Browse.js"
import { Downloads } from "./pages/Downloads.js"
import { Library } from "./pages/Library.js"
import { Settings } from "./pages/Settings.js"
import { PlayerBar } from "./components/PlayerBar.js"

type View = "browse" | "library" | "downloads" | "settings"

export const App = () => {
  const [view, setView] = useState<View>("browse")

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
        <h1>Pi Wallpaper Engine</h1>
        <PlayerBar />
      </header>
      <nav className="nav">
        <button
          className={view === "browse" ? "active" : ""}
          onClick={() => setView("browse")}
        >
          Browse
        </button>
        <button
          className={view === "library" ? "active" : ""}
          onClick={() => setView("library")}
        >
          Library
        </button>
        <button
          className={view === "downloads" ? "active" : ""}
          onClick={() => setView("downloads")}
        >
          Downloads
        </button>
        <button
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          Settings
        </button>
      </nav>
      <main className="main">
        {view === "browse" && <Browse />}
        {view === "library" && <Library />}
        {view === "downloads" && <Downloads />}
        {view === "settings" && <Settings />}
      </main>
    </div>
    </SWRConfig>
  )
}
