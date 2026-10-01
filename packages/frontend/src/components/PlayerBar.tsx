// PlayerBar — the global liquid-glass dock (spec §2.4 / §3.2 / §5 F2).
// Fixed across the bottom of the content column: preview + title/status,
// transport, play-mode tri-state, codec readout, and a compressed icon
// cluster (DISPLAY popover FILL/FIT/STRETCH · display power direct toggle ·
// SLEEP popover OFF/15/30/60M). The dock tucks away on downward scroll and
// returns on upward scroll (350ms, registered §5 exception); tucking
// explicitly nulls the popover so a recall never resurrects a ghost.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { api } from "../api.js"
import type { SystemSummary } from "../api.js"
import { appIcons } from "../icons.js"
import { duration } from "../motionTokens.js"
import { useReducedMotion } from "../reducedMotion.js"
import { sounds } from "../sound.js"
import { DisplayPowerToggle } from "./DisplayPowerToggle.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

const PLAY_MODES = [
  { mode: "single", icon: appIcons.modeSingle, label: "Single (loop one)" },
  { mode: "sequential", icon: appIcons.modeSequential, label: "Sequential" },
  { mode: "shuffle", icon: appIcons.modeShuffle, label: "Shuffle" },
] as const

const DISPLAY_MODES = ["fill", "fit", "stretch"] as const

const SLEEP_OPTIONS = [
  { label: "OFF", minutes: 0 },
  { label: "15M", minutes: 15 },
  { label: "30M", minutes: 30 },
  { label: "60M", minutes: 60 },
] as const

/** Display-mode (FILL/FIT/STRETCH): a frame with corner marks — NOT the
 *  monitor+power glyph, which is the display-power toggle. */
const IconAspect = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M8 9 L6 9 L6 11" />
    <path d="M16 9 L18 9 L18 11" />
    <path d="M8 15 L6 15 L6 13" />
    <path d="M16 15 L18 15 L18 13" />
  </svg>
)

const IconMoon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 13.5 A8.5 8.5 0 1 1 10.5 4 a7 7 0 0 0 9.5 9.5 Z" />
  </svg>
)

type PopoverKind = "display" | "sleep" | null

/** Remaining whole minutes on the sleep timer, for the `sleep Nm` subtitle. */
const sleepMinutesLeft = (sleep: { active: boolean; deadline: number | null } | null): number | null =>
  sleep?.active && sleep.deadline != null
    ? Math.max(0, Math.ceil((sleep.deadline - Date.now()) / 60000))
    : null

export const PlayerBar = ({ summary, onRefresh }: Props) => {
  const [pending, setPending] = useState(false)
  const [displayPending, setDisplayPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tucked, setTucked] = useState(false)
  const reducedMotion = useReducedMotion()

  // F2 (spec §5): explicit exit — a closing popover stays mounted for one
  // 150ms transition before unmounting, so it leaves on the same path it
  // entered. popoverRef mirrors state so timers/listeners see the live kind.
  const [popover, setPopover] = useState<PopoverKind>(null)
  const [closingPop, setClosingPop] = useState<PopoverKind>(null)
  const popoverRef = useRef<PopoverKind>(null)
  const closeAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPop = (p: PopoverKind) => {
    popoverRef.current = p
    setPopover(p)
  }
  const closePop = () => {
    const p = popoverRef.current
    if (!p) return
    // Interface sound (ticket 13): nav dismiss variant on the exit first frame.
    sounds.trigger("dismiss")
    setPop(null)
    setClosingPop(p)
    if (closeAnimTimer.current) clearTimeout(closeAnimTimer.current)
    closeAnimTimer.current = setTimeout(() => setClosingPop(null), duration.exit)
  }
  const openPop = (kind: Exclude<PopoverKind, null>) => {
    // Re-opening mid-exit: cancel the pending unmount — the CSS transition
    // reverses from the presented value, no flash back to zero. Switching
    // straight across (display ↔ sleep) lets the old popover finish its
    // mirrored exit while the new one enters from its own trigger.
    if (closeAnimTimer.current) clearTimeout(closeAnimTimer.current)
    const prev = popoverRef.current
    if (prev && prev !== kind) {
      setClosingPop(prev)
      closeAnimTimer.current = setTimeout(() => setClosingPop(null), duration.exit)
    } else {
      setClosingPop(null)
    }
    setPop(kind)
  }
  const togglePopover = (kind: Exclude<PopoverKind, null>) =>
    popoverRef.current === kind ? closePop() : openPop(kind)

  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)

  const player = summary?.status.player ?? null
  const display = summary?.status.display ?? null
  const hasCurrent = !!player?.current_workshop_id
  const sleepLeft = sleepMinutesLeft(summary?.status.sleep ?? null)
  // Ticket 01 (media-root resilience): a wallpapered player that is sitting
  // idle with the media root gone must not read as "idle". The dock is the one
  // surface visible on every page, so the outage is named here; the status text
  // swaps to it and the causing path is shown underneath.
  const storage = summary?.status.storage ?? null
  const storageDown = storage !== null && !storage.available
  const storageReason = storage?.last_error ?? null

  // Interface sound timing (ticket 13, sound spec §3): the transport row's
  // trigger point is pointerdown — the commit family sounds on the same
  // frame as :active, ahead of the API round-trip. Play/pause/skip itself
  // stays on the click semantic layer (keyboard Enter/Space); the click
  // handler only fires the sound when no pointer press just did.
  const transportSoundAt = useRef<{ id: string; at: number } | null>(null)
  const transportPress = (id: string) => {
    transportSoundAt.current = { id, at: performance.now() }
    sounds.trigger("transport")
  }
  const transportClick = (id: string) => {
    const last = transportSoundAt.current
    if (!last || last.id !== id || performance.now() - last.at > 400)
      sounds.trigger("transport")
  }

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
    // Interface sound (ticket 13): transition family ×0.7 gain, on the
    // status-dot flip.
    sounds.trigger("display")
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

  // Direction-aware tuck (spec §2.5, 350ms): read the .main scroller (lenis
  // wrapper mode — native scroll events fire on it in both modes). Down
  // scroll tucks, up scroll recalls. Tucking explicitly nulls the popover
  // state (spec §5 F2) — no exit animation, no ghost on recall.
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".main")
    if (!scroller) return
    let last = scroller.scrollTop
    const onScroll = () => {
      const y = scroller.scrollTop
      const dy = y - last
      last = y
      if (Math.abs(dy) < 2) return
      if (dy > 0 && y > 96) {
        setTucked(true)
        if (closeAnimTimer.current) clearTimeout(closeAnimTimer.current)
        setClosingPop(null)
        setPop(null)
      } else if (dy < 0) {
        setTucked(false)
      }
    }
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => scroller.removeEventListener("scroll", onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close the popover on Esc or any outside pointer.
  useEffect(() => {
    if (!popover) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePop()
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closePop()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popover])

  // Specular highlight follows the pointer, Liquid Glass style (spec §2.4).
  // Reduced motion (F5): no pointer tracking; the static highlight stays.
  const trackSpecular = (e: React.MouseEvent) => {
    if (reducedMotion) return
    const el = innerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * 100
    const y = ((e.clientY - r.top) / r.height) * 100
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      el.style.setProperty("--gx", `${x.toFixed(1)}%`)
      el.style.setProperty("--gy", `${y.toFixed(1)}%`)
    })
  }

  // F2 positioning (spec §5, measured — not guessed): the popover's bottom
  // edge floats 12px above the GLASS top edge (anchoring to the cluster top
  // would sink it 2px into the glass), its right edge hugs the icon cluster's
  // right edge, and transform-origin lands on the trigger icon's center
  // bottom so enter/exit grows from the exact icon that spawned it.
  // Popovers render as siblings of .pbar-inner — NOT inside it: nested
  // backdrop-filter is dropped in Chromium, which would wash the popover's
  // glass out against the dock's.
  const clusterRef = useRef<HTMLDivElement>(null)
  const displayBtnRef = useRef<HTMLButtonElement>(null)
  const sleepBtnRef = useRef<HTMLButtonElement>(null)
  const displayPopRef = useRef<HTMLDivElement>(null)
  const sleepPopRef = useRef<HTMLDivElement>(null)
  const [popPos, setPopPos] = useState<{ right: number; bottom: number } | null>(null)
  // Layout effect, not a passive one: measure position AND the trigger-anchored
  // transform-origin synchronously before paint — the popover never renders a
  // hidden first frame.
  useLayoutEffect(() => {
    if (!popover) return
    const update = () => {
      const c = clusterRef.current
      const r = rootRef.current
      const inner = innerRef.current
      if (!c || !r || !inner) return
      const cr = c.getBoundingClientRect()
      const rr = r.getBoundingClientRect()
      const ir = inner.getBoundingClientRect()
      setPopPos({ right: rr.right - cr.right, bottom: rr.bottom - ir.top + 12 })
      const pop = (popover === "display" ? displayPopRef : sleepPopRef).current
      const btn = (popover === "display" ? displayBtnRef : sleepBtnRef).current
      if (pop && btn) {
        // The popover's CSS fallback pins it to the dock root's right edge;
        // its inline right/bottom lands only after this effect's setState.
        // Compute the corrected left edge analytically (popover right edge =
        // cluster right edge; width is position-independent max-content).
        const pr = pop.getBoundingClientRect()
        const br = btn.getBoundingClientRect()
        if (pr.width > 0) {
          const correctedLeft = cr.right - pr.width
          const ox = ((br.left + br.width / 2 - correctedLeft) / pr.width) * 100
          pop.style.transformOrigin = `${ox.toFixed(1)}% 100%`
        }
      }
    }
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [popover])

  const renderPopover = (kind: Exclude<PopoverKind, null>) => {
    const open = popover === kind
    const closing = closingPop === kind
    if (!open && !closing) return null
    const isDisplay = kind === "display"
    return (
      <div
        ref={isDisplay ? displayPopRef : sleepPopRef}
        className={`pbar-pop mono ${open ? "" : "pbar-pop-out"}`}
        role="menu"
        aria-label={isDisplay ? "Display mode" : "Sleep timer"}
        style={popPos ? { right: popPos.right, bottom: popPos.bottom } : { visibility: "hidden" }}
      >
        <span className="pbar-pop-label">{isDisplay ? "DISPLAY" : "SLEEP"}</span>
        {isDisplay
          ? DISPLAY_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={player?.display_mode === mode ? "is-on" : ""}
                disabled={pending}
                onClick={() => {
                  // Segmenter semantics: stay open so modes can be flipped
                  // and compared; closes on toggle/Esc/outside click.
                  void runAction(() => api.setDisplayMode(mode))
                }}
              >
                {mode.toUpperCase()}
              </button>
            ))
          : SLEEP_OPTIONS.map((o) => (
              <button
                key={o.label}
                type="button"
                className={
                  (o.minutes === 0 && !summary?.status.sleep.active) ||
                  (o.minutes > 0 && sleepLeft != null && Math.abs(sleepLeft - o.minutes) <= 1)
                    ? "is-on"
                    : ""
                }
                disabled={pending}
                onClick={() => {
                  void runAction(() => api.setSleep(o.minutes))
                  closePop()
                }}
              >
                {o.label}
              </button>
            ))}
      </div>
    )
  }

  if (!summary || !player) {
    return (
      <div className="pbar">
        <div className="pbar-inner">
          <div className="pbar-empty">Connecting to Pi…</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`pbar ${tucked ? "pbar-tucked" : ""}`}
      onMouseMove={trackSpecular}
      ref={rootRef}
    >
      {renderPopover("display")}
      {renderPopover("sleep")}

      <div className="pbar-inner" ref={innerRef}>
        <div className="pbar-media">
          {player.current_preview_url ? (
            <img className="pbar-thumb" src={player.current_preview_url} alt="" />
          ) : (
            <div className="pbar-thumb" aria-hidden="true" />
          )}
          <div className="pbar-copy">
            <div className="pbar-title">
              {player.current_title ?? (hasCurrent ? player.current_workshop_id : "No wallpaper selected")}
            </div>
            <div className="pbar-sub mono">
              {storageDown
                ? "storage unavailable"
                : `${player.current_workshop_id ?? "waiting"} · ${
                    player.playing ? "looping" : hasCurrent ? "paused" : "idle"
                  }`}
              {!storageDown && sleepLeft != null ? ` · sleep ${sleepLeft}m` : ""}
            </div>
          </div>
        </div>

        <div className="pbar-transport">
          <button
            type="button"
            aria-label="Previous wallpaper"
            disabled={pending}
            onPointerDown={() => transportPress("prev")}
            onClick={() => {
              // Interface sound (ticket 13): commit family, icon-swap frame.
              transportClick("prev")
              void runAction(() => api.playerPrev())
            }}
          >
            {appIcons.skipPrev}
          </button>
          <button
            type="button"
            className="pbar-primary"
            aria-label={player.playing ? "Pause playback" : "Resume playback"}
            disabled={!hasCurrent || pending}
            onPointerDown={() => transportPress("play")}
            onClick={() => {
              transportClick("play")
              void runAction(() => (player.playing ? api.pause() : api.resume()))
            }}
          >
            {player.playing ? appIcons.pause : appIcons.play}
          </button>
          <button
            type="button"
            aria-label="Next wallpaper"
            disabled={pending}
            onPointerDown={() => transportPress("next")}
            onClick={() => {
              transportClick("next")
              void runAction(() => api.playerNext())
            }}
          >
            {appIcons.skipNext}
          </button>
        </div>

        <div className="pbar-modes">
          {PLAY_MODES.map(({ mode, icon, label }) => (
            <button
              key={mode}
              type="button"
              aria-label={label}
              title={label}
              className={player.play_mode === mode ? "active" : ""}
              disabled={pending}
              onClick={() => {
                void runAction(() => api.playerMode(mode))
              }}
            >
              {icon}
            </button>
          ))}
        </div>

        <div className="pbar-codec mono">
          {player.current_resolution ?? "—"} · {player.current_codec ?? "—"}
        </div>

        <div className="pbar-cluster" ref={clusterRef}>
          <button
            type="button"
            aria-label="Display mode"
            title={`Display mode: ${player.display_mode}`}
            className={popover === "display" ? "active" : ""}
            ref={displayBtnRef}
            onClick={() => togglePopover("display")}
          >
            <IconAspect />
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
            aria-label="Sleep timer"
            title={sleepLeft != null ? `Sleep in ${sleepLeft}m` : "Sleep timer"}
            className={popover === "sleep" || sleepLeft != null ? "active" : ""}
            ref={sleepBtnRef}
            onClick={() => togglePopover("sleep")}
          >
            <IconMoon />
          </button>
        </div>
      </div>
      {(error || (storageDown && !error)) && (
        <div className="pbar-notice mono">{error ?? storageReason}</div>
      )}
    </div>
  )
}
