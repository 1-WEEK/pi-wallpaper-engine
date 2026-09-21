// FocusRing — the shared 1-bit focus band (implementation ticket 06, spec
// §4.1 10 票 Q 方案 / §2.6 / §5 F4). ONE absolutely positioned element parks
// on the keyboard cursor's card: a 2px Kare checkerboard dither band just
// outside the card ("uncommitted") plus a mono C·R coordinate readout riding
// the frame; Enter flips it into a full-cover XOR difference block
// ("committed") before the caller's open transition runs.
//
// Focus migration is a shared-element FLIP slide (250ms --ease-slide, the
// same paradigm as the 09 nav mask). A re-trigger mid-flight starts from the
// PRESENTED value — the in-flight animation's current frame via
// getComputedStyle, never the previous target — so rapid key repeats have no
// velocity discontinuity (spec §5 F4). Layout shifts (resize, grid reflow)
// snap instantly: ResizeObserver + window resize re-measure and cancel any
// in-flight slide rather than animating to a moving target.
//
// Reusable: ticket 08 (Library) mounts the same ring over its own grid/list.
// The host element must carry .focus-ring-host (position + isolation — the
// XOR blend must stay inside the host's stacking context) and every roamed
// item must match `selector`; both the ring and the items use the host as
// their offsetParent, so measurement stays in pure offset geometry (no
// getBoundingClientRect, no transform pollution).
import { useEffect, useLayoutEffect, useRef } from "react"
import type { RefObject } from "react"
import { prefersReducedMotion } from "../reducedMotion.js"
import { easeSlide } from "../motionTokens.js"

/** Focus migration slide (spec §5 F4). */
export const FOCUS_SLIDE_MS = 250
/** Enter confirm beat: dither out / XOR in before the open transition. */
export const FOCUS_CONFIRM_MS = 120

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FocusRing = ({
  hostRef,
  selector,
  index,
  columns,
  commit = false,
}: {
  /** The positioned container whose children include every roamed item. */
  hostRef: RefObject<HTMLElement | null>
  /** Matches one element per roamed item, in item order (e.g. ".bws-card"). */
  selector: string
  /** Keyboard cursor index into the matched items. */
  index: number
  /** Measured column count for the C·R readout (1 for row-at-a-time lists). */
  columns: number
  /** True during the Enter confirm beat: dither fades out, XOR fades in. */
  commit?: boolean
}) => {
  const ringRef = useRef<HTMLDivElement | null>(null)
  const prevRect = useRef<Rect | null>(null)

  // Kept in a ref so the ResizeObserver closure always sees the latest
  // index/selector. animate=true FLIP-slides from the presented value;
  // animate=false snaps instantly (resize / reflow) and cancels any
  // in-flight slide so its keyframes can't fight the snap.
  const placeRef = useRef<(animate: boolean) => void>(() => {})
  placeRef.current = (animate: boolean) => {
    const ring = ringRef.current
    if (!ring) return
    // hostRef.current can be null here: child layout effects run before the
    // parent's ref attach, and an inline callback ref detaches/re-attaches on
    // every render. The ring's offsetParent IS the host by construction, and
    // unlike the ref it is already resolvable at this point in the commit.
    const host = hostRef.current ?? (ring.offsetParent as HTMLElement | null)
    if (!host) return
    const target = host.querySelectorAll(selector)[index] as HTMLElement | undefined
    if (!target) return
    const rect: Rect = {
      x: target.offsetLeft,
      y: target.offsetTop,
      w: target.offsetWidth,
      h: target.offsetHeight,
    }
    const prev = prevRect.current
    const moved =
      prev !== null &&
      (prev.x !== rect.x || prev.y !== rect.y || prev.w !== rect.w || prev.h !== rect.h)
    if (animate && moved && !prefersReducedMotion()) {
      // F4: capture the presented frame BEFORE cancelling the old animation,
      // all within this frame so nothing flashes. The computed transform of an
      // in-flight WAAPI animation is its current interpolated value.
      const inFlight = ring.getAnimations()
      let from = prev
      if (inFlight.length > 0) {
        const cs = getComputedStyle(ring)
        const m = cs.transform.match(/matrix\(([^)]+)\)/)
        const parts = m?.[1]?.split(",").map(Number)
        from = {
          x: parts?.[4] ?? prev.x,
          y: parts?.[5] ?? prev.y,
          w: parseFloat(cs.width),
          h: parseFloat(cs.height),
        }
      }
      inFlight.forEach((a) => a.cancel())
      ring.animate(
        [
          {
            transform: `translate(${from.x}px, ${from.y}px)`,
            width: `${from.w}px`,
            height: `${from.h}px`,
          },
          {
            transform: `translate(${rect.x}px, ${rect.y}px)`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
          },
        ],
        { duration: FOCUS_SLIDE_MS, easing: easeSlide }
      )
    } else if (!moved) {
      // Unchanged rect: leave any in-flight slide alone (unrelated re-render).
    } else {
      ring.getAnimations().forEach((a) => a.cancel())
    }
    ring.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    ring.style.width = `${rect.w}px`
    ring.style.height = `${rect.h}px`
    prevRect.current = rect
  }

  // Cursor or view changed: FLIP-migrate the shared ring. Runs before paint;
  // an unchanged rect is a no-op so unrelated re-renders never touch it. A
  // selector change (grid ↔ list) is a reflow, not a focus move: snap.
  const lastSelector = useRef(selector)
  useLayoutEffect(() => {
    const snap = lastSelector.current !== selector
    lastSelector.current = selector
    placeRef.current(!snap)
  }, [index, selector])

  // Reflow (window resize, scrollbar (dis)appearing, font load, card-count
  // change): the ring must keep hugging the SAME item, so re-measure and snap
  // instantly — never slide to a layout shift. Observing the host catches
  // every item-position change (it wraps the items edge-to-edge).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const snap = () => placeRef.current(false)
    const ro = new ResizeObserver(snap)
    ro.observe(host)
    window.addEventListener("resize", snap)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", snap)
    }
  }, [hostRef])

  const col = (index % Math.max(1, columns)) + 1
  const row = Math.floor(index / Math.max(1, columns)) + 1

  return (
    <div ref={ringRef} className={`focus-ring${commit ? " commit" : ""}`} aria-hidden="true">
      <div className="focus-ring-dither" />
      <div className="focus-ring-xor" />
      <span className="focus-ring-coord mono">
        C{col}·R{row}
      </span>
    </div>
  )
}
