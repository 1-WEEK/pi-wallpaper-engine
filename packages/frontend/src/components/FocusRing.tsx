// FocusRing — the shared 1-bit focus band (implementation ticket 06, spec
// §4.1 10 票 Q 方案 / §2.6 / §5 F4). ONE absolutely positioned element parks
// on the keyboard cursor's card: a 2px Kare checkerboard dither band just
// outside the card ("uncommitted") plus a mono C·R coordinate readout riding
// the frame; Enter flips it into a full-cover XOR difference block
// ("committed") before the caller's open transition runs.
//
// Focus migration is a shared-element FLIP slide (250ms --ease-slide, the
// same paradigm as the 09 nav mask), transform-only like ghost.ts (spec §5
// F6): the ring's box parks at the flight's FROM rect and the WAAPI runs
// translate + scaleX/scaleY on the compositor — no layout properties
// animate. The 2px dither band would thicken under scale, so the dither's
// own padding flies the inverse compensation (2px → 2/scale, ghost.ts's
// border-radius trick), keeping the band 2px wide throughout. A re-trigger
// mid-flight starts from the PRESENTED value — the in-flight animation's
// current frame via getComputedStyle, never the previous target — so rapid
// key repeats have no velocity discontinuity (spec §5 F4). Layout shifts
// (resize, grid reflow) snap instantly: ResizeObserver + window resize
// re-measure and cancel any in-flight slide rather than animating to a
// moving target.
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

/** Visual width of the checker band (focusRing.css .focus-ring-dither). */
const BAND_PX = 2

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
  const ditherRef = useRef<HTMLDivElement | null>(null)
  const prevRect = useRef<Rect | null>(null)
  // The rect the ring's box is currently parked at (a flight's from, or the
  // committed target at rest) — the base over which the animated matrix maps.
  const parkedRect = useRef<Rect | null>(null)

  const park = (ring: HTMLElement, rect: Rect) => {
    ring.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    ring.style.width = `${rect.w}px`
    ring.style.height = `${rect.h}px`
    parkedRect.current = rect
  }

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
      // all within this frame so nothing flashes. During a flight the WAAPI
      // owns the transform outright (absolute translate + scale keyframes),
      // so the computed matrix maps the parked box to the presented rect.
      const inFlight = ring.getAnimations()
      let from = prev
      const parked = parkedRect.current ?? prev
      if (inFlight.length > 0) {
        const m = getComputedStyle(ring).transform.match(/matrix\(([^)]+)\)/)
        const parts = m?.[1]?.split(",").map(Number)
        from = {
          x: parts?.[4] ?? parked.x,
          y: parts?.[5] ?? parked.y,
          w: parked.w * (parts?.[0] ?? 1),
          h: parked.h * (parts?.[3] ?? 1),
        }
      }
      inFlight.forEach((a) => a.cancel())
      ditherRef.current?.getAnimations().forEach((a) => a.cancel())
      // Transform FLIP (§5 F6): park the box at FROM and fly translate +
      // scale to the target; nothing but transform animates.
      park(ring, from)
      const sx = rect.w / from.w
      const sy = rect.h / from.h
      const anim = ring.animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px) scale(1, 1)` },
          { transform: `translate(${rect.x}px, ${rect.y}px) scale(${sx}, ${sy})` },
        ],
        { duration: FOCUS_SLIDE_MS, easing: easeSlide, fill: "forwards" }
      )
      // Band-width compensation: the checker band's thickness is the dither's
      // padding, which would scale with the ring — fly it the inverse way so
      // the band stays visually 2px (ghost.ts's border-radius trick). A no-op
      // at scale 1 (uniform cards), so it only matters across a size change.
      const ditherAnim =
        sx === 1 && sy === 1
          ? null
          : ditherRef.current?.animate(
              [
                { padding: `${BAND_PX}px` },
                { padding: `${BAND_PX / sy}px ${BAND_PX / sx}px` },
              ],
              { duration: FOCUS_SLIDE_MS, easing: easeSlide, fill: "forwards" }
            )
      if (ditherAnim) void ditherAnim.finished.catch(() => {})
      anim.finished.then(
        () => {
          // Commit the landing: park on the target and drop the fills.
          park(ring, rect)
          anim.cancel()
          ditherAnim?.cancel()
        },
        () => {}
      )
    } else if (!moved) {
      // Unchanged rect: leave any in-flight slide alone (unrelated re-render).
    } else {
      ring.getAnimations().forEach((a) => a.cancel())
      ditherRef.current?.getAnimations().forEach((a) => a.cancel())
      park(ring, rect)
    }
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
      <div ref={ditherRef} className="focus-ring-dither" />
      <div className="focus-ring-xor" />
      <span className="focus-ring-coord mono">
        C{col}·R{row}
      </span>
    </div>
  )
}
