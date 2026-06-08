import { useState } from "react"
import { api } from "../../api.js"
import type { SystemSummary } from "../../api.js"
import { appIcons } from "../../icons.js"
import { DisplayPowerToggle } from "../DisplayPowerToggle.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

export const MobileMiniPlayer = ({ summary, onRefresh }: Props) => {
  const [pending, setPending] = useState(false)
  const [displayPending, setDisplayPending] = useState(false)
  const player = summary?.status.player ?? null
  const display = summary?.status.display ?? null
  const hasCurrent = !!player?.current_workshop_id

  const runAction = async (action: () => Promise<unknown>) => {
    setPending(true)
    try {
      await action()
      onRefresh()
    } finally {
      setPending(false)
    }
  }

  const togglePower = async () => {
    if (!display || !display.configured) return
    setDisplayPending(true)
    try {
      if (display.state === "on") await api.displayOff()
      else await api.displayOn()
      onRefresh()
    } catch (e) {
      console.error("Display toggle failed", e)
      onRefresh()
    } finally {
      setDisplayPending(false)
    }
  }

  return (
    <div className="mobile-mini-player">
      <div className="mobile-mini-player-media">
        {player?.current_preview_url ? (
          <img
            src={player.current_preview_url}
            alt=""
            className="mobile-mini-player-thumb"
          />
        ) : (
          <div className="mobile-mini-player-thumb mobile-mini-player-thumb-empty" />
        )}
        {player?.playing && (
          <div className="mobile-mini-player-eq" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="mobile-mini-player-copy">
        <div className="mobile-mini-player-title">
          {player?.current_title ??
            (hasCurrent ? player?.current_workshop_id : "No wallpaper selected")}
        </div>
        <div className="mobile-mini-player-meta mono">
          {player?.current_resolution ?? "—"} · HDMI ·{" "}
          {display?.configured ? display.state : "n/a"}
        </div>
      </div>
      <DisplayPowerToggle
        state={display?.state ?? "unknown"}
        configured={!!display?.configured}
        pending={displayPending}
        onToggle={togglePower}
        compact
      />
      <button
        type="button"
        className="mobile-mini-player-btn"
        aria-label="Stop playback"
        disabled={!hasCurrent || pending}
        onClick={() => void runAction(() => api.stop())}
      >
        {appIcons.stop}
      </button>
      <button
        type="button"
        className="mobile-mini-player-btn"
        aria-label="Previous wallpaper"
        disabled={pending}
        onClick={() => void runAction(() => api.playerPrev())}
      >
        {appIcons.skipPrev}
      </button>
      <button
        type="button"
        className="mobile-mini-player-btn mobile-mini-player-btn-primary"
        aria-label={player?.playing ? "Pause" : "Play"}
        disabled={!hasCurrent || pending}
        onClick={() =>
          void runAction(() => (player?.playing ? api.pause() : api.resume()))
        }
      >
        {player?.playing ? appIcons.pause : appIcons.play}
      </button>
      <button
        type="button"
        className="mobile-mini-player-btn"
        aria-label="Next wallpaper"
        disabled={pending}
        onClick={() => void runAction(() => api.playerNext())}
      >
        {appIcons.skipNext}
      </button>
    </div>
  )
}
