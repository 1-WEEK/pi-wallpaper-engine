// Unified Sheet skeleton (mobile spec §3.4): opaque --pt-bg panel +
// rgba(0,0,0,0.55) blur-free scrim, two detents ("88%" / "auto"), same-
// frame enter (panel 300ms + scrim 200ms) and synchronous programmatic
// exit (200/200 — the old 60ms panel delay is deleted). Vertical drag-to-
// dismiss follows the finger 1:1 by writing transform strings directly
// (no WAAPI, no filter), lerps the scrim with progress, rubber-bands
// over-top drags (0.35 damping, 48px cap), and on release projects
// (dy + v·200ms ≥ 40% of panel height → dismiss; downward flick
// ≥0.5px/ms → dismiss regardless of distance; upward flick ≤−0.3px/ms
// → snap back). The release settle is a spring (stiffness 420 / damping
// 38 / mass 1, initial velocity = release velocity) that always starts
// from the presentation value (DOMMatrixReadOnly) and is cancelled by
// generation when a new gesture grabs mid-flight. Gesture physics is
// registered outside the duration-scale budget (05 D5).
// Scrim dismiss contract (§8.1): the scrim answers ONLY a paired
// pointerdown+pointerup gesture on itself — never the click channel — so
// the compatibility synthetic click after a release-commit cannot
// phantom-dismiss a just-opened sheet.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { appIcons } from "../../icons.js"
import { useReducedMotion } from "../../reducedMotion.js"
import { sounds } from "../../sound.js"

interface Props {
  open: boolean
  onClose: () => void
  title?: ReactNode
  action?: ReactNode
  /** Detent: "88%" (filters / detail) or "auto" (player, content-sized). */
  height?: string
  /** Sticky footer strip (48px CTA grammar, spec §4.1/§3.4): pinned below
   *  the scrolling body so the commit action is always reachable. */
  footer?: ReactNode
  children: ReactNode
}

// Spring constants (05 D5 — registered gesture physics, not a token).
const SPRING_K = 420
const SPRING_C = 38
const SPRING_M = 1

interface DragState {
  x0: number
  y0: number
  active: boolean
  /** Client Y at the moment the drag activated. */
  actY: number
  /** Panel translateY read from the presentation matrix at activation. */
  baseY: number
  samples: Array<[number, number]>
  st0: number
  manual: boolean
  pointerId: number
}

export const MobileSheet = ({
  open,
  onClose,
  title,
  action,
  height = "88%",
  footer,
  children,
}: Props) => {
  const reducedMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const springGenRef = useRef(0)
  const scrimDownRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion

  // Cache contents while open so frame-0 unmounts during the 200ms exit transition
  // do not produce a blank panel container (spec §3.4 / F1 parity).
  const cachedChildren = useRef(children)
  if (open) cachedChildren.current = children
  const cachedTitle = useRef(title)
  if (open && title !== undefined) cachedTitle.current = title
  const cachedAction = useRef(action)
  if (open && action !== undefined) cachedAction.current = action
  const cachedFooter = useRef(footer)
  if (open && footer !== undefined) cachedFooter.current = footer

  const displayTitle = open ? title : cachedTitle.current
  const displayAction = open ? action : cachedAction.current
  const displayFooter = open ? footer : cachedFooter.current
  const displayChildren = open ? children : cachedChildren.current
  // Reset engine-owned inline styles whenever the sheet opens.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const scrim = scrimRef.current
    if (!panel || !scrim) return
    for (const el of [panel, scrim]) {
      el.style.transform = ""
      el.style.transition = ""
      el.style.opacity = ""
    }
  }, [open])

  // The release settle: spring 420/38/1 from the presentation value with
  // the release velocity; a new gesture bumps the generation to cancel.
  const springTo = (x0: number, v0: number, target: number, pH: number, done: () => void) => {
    const panel = panelRef.current
    const scrim = scrimRef.current
    if (!panel || !scrim) return
    if (reducedRef.current) {
      // 05 D8: dismiss fades in place; cancel eases back 120ms.
      panel.style.transition = target
        ? "opacity 150ms var(--ease-out)"
        : "transform 120ms var(--ease-out)"
      if (target) {
        panel.style.opacity = "0"
        setTimeout(() => {
          panel.style.opacity = ""
          done()
        }, 160)
      } else {
        panel.style.transform = "translateY(0)"
        scrim.style.transition = ""
        scrim.style.opacity = ""
      }
      return
    }
    let x = x0
    let v = v0
    let last = performance.now()
    const gen = ++springGenRef.current
    const step = (now: number) => {
      if (gen !== springGenRef.current) return // superseded by a new gesture/spring
      const dt = Math.min(0.032, (now - last) / 1000)
      last = now
      const a = (-SPRING_K * (x - target) - SPRING_C * v) / SPRING_M
      v += a * dt
      x += v * dt
      panel.style.transform = `translateY(${x}px)`
      scrim.style.opacity = String(Math.max(0, 1 - x / pH))
      if (Math.abs(x - target) > 0.5 || Math.abs(v) > 20) requestAnimationFrame(step)
      else {
        panel.style.transition = ""
        scrim.style.transition = ""
        scrim.style.opacity = ""
        panel.style.transform = target ? `translateY(${target}px)` : ""
        done()
      }
    }
    requestAnimationFrame(step)
  }

  const onPanelPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || !open) return
    const body = bodyRef.current
    const inChrome = !!(e.target as HTMLElement | null)?.closest(
      ".mobile-sheet-grab, .mobile-sheet-header"
    )
    const atTop = !body || body.scrollTop <= 0
    if (!inChrome && !atTop) return
    springGenRef.current++ // a gesture owns the panel; kill any in-flight spring
    dragRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      active: false,
      actY: e.clientY,
      baseY: 0,
      samples: [],
      st0: body ? body.scrollTop : 0,
      manual: !inChrome && atTop,
      pointerId: e.pointerId,
    }
  }

  const onPanelPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const panel = panelRef.current
    const scrim = scrimRef.current
    if (!d || !panel || !scrim || !e.isPrimary || d.pointerId !== e.pointerId) return
    const body = bodyRef.current
    const dy = e.clientY - d.y0
    const dx = e.clientX - d.x0
    if (!d.active) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2 && dy > 0) {
        d.active = true
        d.actY = e.clientY
        // Start from the on-screen (presentation) value, never the target.
        d.baseY = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42 || 0
        panel.setPointerCapture(e.pointerId)
        panel.style.transition = "none"
        scrim.style.transition = "none"
        if (body) body.style.touchAction = "none"
      } else if (d.manual && body && dy < 0) {
        // Upward: hand the delta to the body's scroll position.
        body.scrollTop = d.st0 - dy
        return
      } else if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        // Horizontal-dominant: not ours (system edge back wins, 02§4).
        dragRef.current = null
        if (body) body.style.touchAction = ""
        return
      } else return
    }
    d.samples.push([e.timeStamp, e.clientY])
    if (d.samples.length > 5) d.samples.shift()
    const pH = panel.offsetHeight
    const raw = d.baseY + (e.clientY - d.actY)
    const y = raw >= 0 ? raw : -Math.min(48, 0.35 * -raw)
    panel.style.transform = `translateY(${y}px)`
    scrim.style.opacity = String(Math.max(0, 1 - y / pH))
  }

  const onPanelPointerFinish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = dragRef.current
    const panel = panelRef.current
    const scrim = scrimRef.current
    if (!d || !panel || !scrim || d.pointerId !== e.pointerId) return
    dragRef.current = null
    const body = bodyRef.current
    if (body) body.style.touchAction = ""
    if (!d.active) return
    const pH = panel.offsetHeight
    const raw = d.baseY + (e.clientY - d.actY)
    const y = raw >= 0 ? raw : -Math.min(48, 0.35 * -raw)
    let v = 0 // px/ms
    const first = d.samples[0]
    const lastSample = d.samples[d.samples.length - 1]
    if (first && lastSample && d.samples.length >= 2 && lastSample[0] > first[0]) {
      v = (lastSample[1] - first[1]) / (lastSample[0] - first[0])
    }
    if (cancelled) v = 0
    const projected = y + v * 200
    const dismiss = !cancelled && (projected >= 0.4 * pH || v >= 0.5) && v > -0.3
    if (dismiss) sounds.trigger("dismiss")
    springTo(y, v * 1000, dismiss ? pH : 0, pH, () => {
      if (dismiss) onCloseRef.current()
    })
  }

  return (
    <div
      className={`mobile-sheet ${open ? "open" : ""}`}
      style={{ "--mobile-sheet-height": height } as React.CSSProperties}
      aria-hidden={!open}
    >
      <div
        className="mobile-sheet-scrim"
        ref={scrimRef}
        role="presentation"
        onPointerDown={(e) => {
          scrimDownRef.current = e.isPrimary && e.target === scrimRef.current
        }}
        onPointerUp={(e) => {
          if (e.isPrimary && scrimDownRef.current && e.target === scrimRef.current) {
            sounds.trigger("dismiss")
            onCloseRef.current()
          }
          scrimDownRef.current = false
        }}
        onPointerCancel={() => {
          scrimDownRef.current = false
        }}
      />
      <div
        className="mobile-sheet-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={(e) => onPanelPointerFinish(e, false)}
        onPointerCancel={(e) => onPanelPointerFinish(e, true)}
      >
        <div className="mobile-sheet-grab">
          <div className="mobile-sheet-grabber" aria-hidden="true" />
        </div>
        {displayTitle !== undefined && displayTitle !== null && (
          <div className="mobile-sheet-header">
            <div className="mobile-sheet-title">{displayTitle}</div>
            {displayAction}
            <button
              type="button"
              className="mobile-sheet-close"
              data-press="icon"
              onClick={() => {
                sounds.trigger("dismiss")
                onClose()
              }}
              aria-label="Close"
            >
              {appIcons.close}
            </button>
          </div>
        )}
        <div className="mobile-sheet-body" ref={bodyRef}>
          {displayChildren}
        </div>
        {displayFooter ? <div className="mobile-sheet-footer">{displayFooter}</div> : null}
      </div>
    </div>
  )
}
