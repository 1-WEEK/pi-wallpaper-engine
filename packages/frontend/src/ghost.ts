// FLIP ghost (spec §2.5 / §5 F6): clone a media element into a fixed-position
// ghost at `from` and fly it to `to` with WAAPI translate + scale on the
// compositor. Border radius is interpolated in from-space and divided by the
// landing scale so corners land pixel-true. The shared pattern for every
// cross-boundary flight (detail close, download receipt, library → player).
// Reduced motion (F5): no ghost at all — onDone fires immediately.
import { easeOut, duration } from "./motionTokens.js"
import { prefersReducedMotion } from "./reducedMotion.js"

// Ghost channels (ticket 12): one flight per channel at a time. Re-triggering
// a channel kills its in-flight ghost instantly (cancel + remove, its onDone
// suppressed) instead of queueing — rapid repeated ADDs/PLAYs never stack.
const inflight = new Map<string, { ghost: HTMLElement; kill: () => void }>()

export const flyGhost = ({
  from,
  to,
  src,
  duration: ms = duration.base,
  fromRadius = "0px",
  toRadius = "0px",
  channel,
  onDone,
}: {
  from: DOMRect
  to: DOMRect
  src?: string
  duration?: number
  fromRadius?: string
  toRadius?: string
  /** Dedup key: spawning on a live channel replaces the old ghost. */
  channel?: string
  onDone?: () => void
}): void => {
  if (
    prefersReducedMotion() ||
    from.width <= 0 ||
    from.height <= 0 ||
    to.width <= 0 ||
    to.height <= 0
  ) {
    onDone?.()
    return
  }
  if (channel) inflight.get(channel)?.kill()
  const sx = to.width / from.width
  const sy = to.height / from.height
  const k = (sx + sy) / 2
  const scaleRadius = (r: string) =>
    r.replace(/(\d+(?:\.\d+)?)px/g, (_m, n) => `${(parseFloat(n) / k).toFixed(2)}px`)
  const ghost = document.createElement(src ? "img" : "div")
  if (src) (ghost as HTMLImageElement).src = src
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    objectFit: "cover",
    zIndex: "90",
    pointerEvents: "none",
    margin: "0",
    borderRadius: fromRadius,
    transformOrigin: "0 0",
    willChange: "transform",
  })
  document.body.appendChild(ghost)
  let killed = false
  const anim = ghost.animate(
    [
      { transform: "translate(0px, 0px) scale(1, 1)", borderRadius: fromRadius },
      {
        transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`,
        borderRadius: scaleRadius(toRadius),
      },
    ],
    { duration: ms, easing: easeOut, fill: "forwards" }
  )
  anim.finished.finally(() => {
    ghost.remove()
    if (channel && inflight.get(channel)?.ghost === ghost) inflight.delete(channel)
    // A channel-killed ghost is replaced, not completed — only the surviving
    // flight may run the landing beat (e.g. the navpulse receipt).
    if (!killed) onDone?.()
  })
  if (channel) {
    inflight.set(channel, {
      ghost,
      kill: () => {
        killed = true
        anim.cancel()
        ghost.remove()
      },
    })
  }
}
