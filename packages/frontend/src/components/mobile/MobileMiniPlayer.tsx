import { useState } from "react"
import { api } from "../../api.js"
import type { SystemSummary } from "../../api.js"
import { appIcons } from "../../icons.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

export const MobileMiniPlayer = ({ summary, onRefresh }: Props) => {
  const [pending, setPending] = useState(false)
  const player = summary?.status.player ?? null
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
          {player ? player.display_mode : "fill"}
        </div>
      </div>
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
        className="mobile-mini-player-btn mobile-mini-player-btn-primary"
        aria-label={player?.playing ? "Pause" : "Play"}
        disabled={!hasCurrent || pending}
        onClick={() =>
          void runAction(() => (player?.playing ? api.pause() : api.resume()))
        }
      >
        {player?.playing ? appIcons.pause : appIcons.play}
      </button>
    </div>
  )
}
