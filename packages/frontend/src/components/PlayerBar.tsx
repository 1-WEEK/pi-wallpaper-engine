import { useState } from "react"
import { api } from "../api.js"
import type { SystemSummary } from "../api.js"
import { appIcons } from "../icons.js"
import { DisplayPowerToggle } from "./DisplayPowerToggle.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

const DISPLAY_MODES = ["fill", "fit", "stretch"] as const

const PLAY_MODES = [
  { mode: "single", icon: appIcons.modeSingle, label: "Single (loop one)" },
  { mode: "sequential", icon: appIcons.modeSequential, label: "Sequential" },
  { mode: "shuffle", icon: appIcons.modeShuffle, label: "Shuffle" },
] as const

export const PlayerBar = ({ summary, onRefresh }: Props) => {
  const [pending, setPending] = useState(false)
  const [displayPending, setDisplayPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const player = summary?.status.player ?? null
  const display = summary?.status.display ?? null
  const hasCurrent = !!player?.current_workshop_id

  const runAction = async (action: () => Promise<unknown>) => {
    setPending(true)
    setError(null)
    try {
      await action()
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const togglePower = async () => {
    if (!display || !display.configured) return
    setDisplayPending(true)
    setError(null)
    try {
      if (display.state === "on") await api.displayOff()
      else await api.displayOn()
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDisplayPending(false)
    }
  }

  if (!summary || !player) {
    return (
      <div className="player-dock">
        <div className="player-dock-inner">
          <div className="player-empty">Connecting to Pi…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="player-dock">
      <div className="player-dock-inner">
        <div className="player-media">
          {player.current_preview_url ? (
            <img
              className="player-preview"
              src={player.current_preview_url}
              alt=""
              width={64}
              height={58}
            />
          ) : (
            <div className="player-preview player-preview-placeholder" />
          )}
          <div className="player-copy">
            <div className="player-title">
              {player.current_title ?? (hasCurrent ? player.current_workshop_id : "No wallpaper selected")}
            </div>
            <div className="player-subtitle mono">
              {player.current_workshop_id ?? "waiting"} ·{" "}
              {player.playing ? "looping" : hasCurrent ? "paused" : "idle"}
            </div>
          </div>
        </div>

        <div className="player-transport">
          <button
            type="button"
            className="player-control player-control-icon"
            aria-label="Stop playback"
            disabled={!hasCurrent || pending}
            onClick={() => {
              void runAction(() => api.stop())
            }}
          >
            {appIcons.stop}
          </button>
          <button
            type="button"
            className="player-control player-control-icon"
            aria-label="Previous wallpaper"
            disabled={pending}
            onClick={() => {
              void runAction(() => api.playerPrev())
            }}
          >
            {appIcons.skipPrev}
          </button>
          <button
            type="button"
            className="player-control player-control-primary player-control-icon"
            aria-label={player.playing ? "Pause playback" : "Resume playback"}
            disabled={!hasCurrent || pending}
            onClick={() => {
              void runAction(() => (player.playing ? api.pause() : api.resume()))
            }}
          >
            {player.playing ? appIcons.pause : appIcons.play}
          </button>
          <button
            type="button"
            className="player-control player-control-icon"
            aria-label="Next wallpaper"
            disabled={pending}
            onClick={() => {
              void runAction(() => api.playerNext())
            }}
          >
            {appIcons.skipNext}
          </button>
        </div>

        <div className="player-segmented player-mode-segmented">
          <span className="player-segmented-label mono">play</span>
          <div className="segmented">
            {PLAY_MODES.map(({ mode, icon, label }) => (
              <button
                key={mode}
                type="button"
                className={`segmented-button ${player.play_mode === mode ? "active" : ""}`}
                aria-label={label}
                title={label}
                disabled={pending}
                onClick={() => {
                  void runAction(() => api.playerMode(mode))
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>

        <div className="player-codec mono">
          {player.current_resolution ?? "—"} · {player.current_codec ?? "—"}
        </div>

        <div className="player-right">
          <DisplayPowerToggle
            state={display?.state ?? "unknown"}
            configured={!!display?.configured}
            pending={displayPending}
            onToggle={togglePower}
          />
          <div className="player-segmented">
            <span className="player-segmented-label mono">display</span>
            <div className="segmented">
              {DISPLAY_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`segmented-button ${
                    player.display_mode === mode ? "active" : ""
                  }`}
                  disabled={pending}
                  onClick={() => {
                    void runAction(() => api.setDisplayMode(mode))
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error && <div className="player-error">{error}</div>}
    </div>
  )
}
