import { useEffect, useState } from "react"
import type { DisplayMode } from "@pwe/shared"
import { api } from "../api.js"

interface Status {
  playing: boolean
  current_workshop_id: string | null
  path: string | null
  display_mode: DisplayMode
}

export const PlayerBar = () => {
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    const tick = () => {
      api.playerStatus().then(setStatus).catch(() => setStatus(null))
    }
    tick()
    const handle = setInterval(tick, 2000)
    return () => clearInterval(handle)
  }, [])

  if (!status) return <div className="player-bar">Player offline</div>

  return (
    <div className="player-bar">
      <span className="player-state">
        {status.playing ? "▶ Playing" : "⏸ Idle"}{" "}
        {status.current_workshop_id && <code>{status.current_workshop_id}</code>}
      </span>
      {status.playing && (
        <button onClick={() => api.pause()}>Pause</button>
      )}
      {!status.playing && status.current_workshop_id && (
        <button onClick={() => api.resume()}>Resume</button>
      )}
      {status.current_workshop_id && <button onClick={() => api.stop()}>Stop</button>}
      <select
        value={status.display_mode}
        onChange={(e) => api.setDisplayMode(e.target.value as DisplayMode)}
      >
        <option value="fill">Fill</option>
        <option value="fit">Fit</option>
        <option value="stretch">Stretch</option>
      </select>
    </div>
  )
}
