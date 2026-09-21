// MobileMiniPlayer (ticket 14, spec §9) — the PlayerBar's mobile
// degradation: MiniPlayer + Sheet. The bar keeps the transport and the
// display-power toggle; tapping the media/copy area opens a Sheet with
// the PlayerBar's remaining instant controls (play mode / display mode /
// sleep), so no control is lost in the degradation.
import { useState } from "react"
import { api } from "../../api.js"
import type { SystemSummary } from "../../api.js"
import { appIcons } from "../../icons.js"
import { DisplayPowerToggle } from "../DisplayPowerToggle.js"
import { MobileSheet } from "./MobileSheet.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

const PLAY_MODES = [
  { mode: "single", label: "SINGLE" },
  { mode: "sequential", label: "SEQUENTIAL" },
  { mode: "shuffle", label: "SHUFFLE" },
] as const

const DISPLAY_MODES = ["fill", "fit", "stretch"] as const

const SLEEP_OPTIONS = [
  { label: "OFF", minutes: 0 },
  { label: "15M", minutes: 15 },
  { label: "30M", minutes: 30 },
  { label: "60M", minutes: 60 },
] as const

export const MobileMiniPlayer = ({ summary, onRefresh }: Props) => {
  const [pending, setPending] = useState(false)
  const [displayPending, setDisplayPending] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const player = summary?.status.player ?? null
  const display = summary?.status.display ?? null
  const sleep = summary?.status.sleep ?? null
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

  const title =
    player?.current_title ?? (hasCurrent ? player?.current_workshop_id : "No wallpaper selected")

  return (
    <>
      <div className="mobile-mini-player">
        <button
          type="button"
          className="mobile-mini-player-open"
          aria-label="Open player controls"
          onClick={() => setSheetOpen(true)}
        >
          <span className="mobile-mini-player-media">
            {player?.current_preview_url ? (
              <img
                src={player.current_preview_url}
                alt=""
                className="mobile-mini-player-thumb"
              />
            ) : (
              <span className="mobile-mini-player-thumb mobile-mini-player-thumb-empty" />
            )}
            {player?.playing && (
              <span className="mobile-mini-player-eq" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
          </span>
          <span className="mobile-mini-player-copy">
            <span className="mobile-mini-player-title">{title}</span>
            <span className="mobile-mini-player-meta mono">
              {player?.current_resolution ?? "—"} · HDMI ·{" "}
              {display?.configured ? display.state : "n/a"}
            </span>
          </span>
        </button>
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

      <MobileSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={title}
        height="auto"
      >
        <div className="mps">
          <div>
            <div className="mps-label">
              <span>PLAY MODE</span>
            </div>
            <div className="set-seg mono" role="radiogroup" aria-label="Play mode">
              {PLAY_MODES.map(({ mode, label }) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={player?.play_mode === mode}
                  className={player?.play_mode === mode ? "is-on" : ""}
                  disabled={pending}
                  onClick={() => void runAction(() => api.playerMode(mode))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mps-label">
              <span>DISPLAY</span>
            </div>
            <div className="set-seg mono" role="radiogroup" aria-label="Display mode">
              {DISPLAY_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={player?.display_mode === mode}
                  className={player?.display_mode === mode ? "is-on" : ""}
                  disabled={pending || !hasCurrent}
                  onClick={() => void runAction(() => api.setDisplayMode(mode))}
                >
                  {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mps-label">
              <span>SLEEP</span>
            </div>
            <div className="set-seg mono" role="radiogroup" aria-label="Sleep timer">
              {SLEEP_OPTIONS.map((o) => {
                const on =
                  (o.minutes === 0 && !sleep?.active) ||
                  (o.minutes > 0 &&
                    !!sleep?.active &&
                    sleep.deadline != null &&
                    Math.abs(Math.ceil((sleep.deadline - Date.now()) / 60000) - o.minutes) <= 1)
                return (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? "is-on" : ""}
                    disabled={pending}
                    onClick={() => void runAction(() => api.setSleep(o.minutes))}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>
            <div className="mps-note">
              {sleep?.active && sleep.deadline != null
                ? `OFF IN ${Math.max(0, Math.ceil((sleep.deadline - Date.now()) / 60000))}M`
                : "SLEEP TIMER INACTIVE"}
            </div>
          </div>
        </div>
      </MobileSheet>
    </>
  )
}
