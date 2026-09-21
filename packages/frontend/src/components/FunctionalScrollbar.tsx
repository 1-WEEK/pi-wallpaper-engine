// Functional scrollbar for the Browse long grid (implementation ticket 07 —
// spec §2.3 "功能性滚动条", 08 票定稿: E interaction core + L visual skin).
//
// Interaction: the thumb's position AND length both LERP toward their
// targets (~0.16 / 0.14 per frame), so an infinite-scroll append shrinks the
// thumb smoothly instead of jumping. Idle ~1.4s fades the bar out; scrolling
// or a pointer near the right edge fades it back in. The hot zone widens the
// thumb 5px → 11px. Dragging is zero-damping (pointer capture) with a `137 /
// 240` readout chip; clicking the track jumps so the thumb centers on the
// click. Scroll position is read from lenis `animatedScroll` and drags are
// written back through lenis `scrollTo` (ticket 01 binds lenis to the .main
// scroller in wrapper mode).
//
// Visual: the canvas draws the Kare 1-bit dithered dot track and the PAGE
// graduations (P01… near-dark at rest, developing while the bar is active);
// the thumb is a DOM liquid-glass sliver (canvas can't do backdrop-filter).
//
// The rAF loop parks 300ms after the last activity (spec §5 F8) — scroll,
// drag, hover, resize and content growth all wake it. Reduced motion never
// mounts this component (Browse.tsx): RM keeps the native thin scrollbar.
// Touch/pointer geometry is parameterized below so a mobile scheme can plug
// in later (spec §2.3 leaves that door open, no mobile proposal here).
import { useEffect, useRef, type RefObject } from "react"
import { getLenis } from "../useLenis.js"

const LERP_POS = 0.16 // thumb position per frame (spec §2.3: ~0.14–0.16)
const LERP_LEN = 0.14 // thumb length per frame
const LERP_WIDEN = 0.2 // hot-zone 5px → 11px widening
const THUMB_W = 5
const THUMB_W_HOT = 11
const THUMB_MIN = 28
const IDLE_HIDE_MS = 1400 // spec §2.3: idle ~1.4s auto-hide
const RAF_PARK_MS = 300 // spec §5 F8: park the loop 300ms after rest
const PROXIMITY_PX = 36 // pointer this close to the right edge fades the bar in
const GRAB_PAD = 6 // hit-test slack around the thumb

export const FunctionalScrollbar = ({
  rootRef,
  itemSelector,
  pageSize,
  total,
}: {
  /** The .bws root: locates the .main scroller and hosts tick measurement. */
  rootRef: RefObject<HTMLElement | null>
  /** Selector of the paged items (".bws-card" / ".ledger-row"). */
  itemSelector: string
  /** Items per loaded page — the PAGE graduation cadence. */
  pageSize: number
  /** Total result count — the drag chip's denominator (`137 / 240`). */
  total: number
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const track = trackRef.current
    const canvas = canvasRef.current
    const thumb = thumbRef.current
    const chip = chipRef.current
    const root = rootRef.current
    const scroller = root?.closest(".main") as HTMLElement | null
    const ctx = canvas?.getContext("2d")
    if (!track || !canvas || !thumb || !chip || !root || !scroller || !ctx) return

    const lenis = getLenis()
    document.documentElement.classList.add("pt-fbar")

    let raf = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let H = 0
    let W = 0
    let hot = false
    let dragging = false
    let dragOffset = 0
    let lastDocH = 0
    let lastActive = 0
    let ticks: number[] = []
    const cur = { y: 0, len: 60, w: THUMB_W }
    const tgt = { y: 0, len: 60 }

    const scrollPos = () => lenis?.animatedScroll ?? scroller.scrollTop
    const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const writeScroll = (y: number, immediate: boolean) => {
      if (lenis) lenis.scrollTo(y, { immediate })
      else scroller.scrollTop = y
    }

    // Content-space top via the offset chain (spec §2.3 bans
    // getBoundingClientRect for measured geometry — transforms pollute it).
    const contentTop = (el: HTMLElement): number => {
      let top = 0
      let node: HTMLElement | null = el
      while (node && node !== scroller) {
        top += node.offsetTop
        node = node.offsetParent as HTMLElement | null
      }
      return top
    }

    // PAGE graduations: one etch per loaded page, at the content-space top
    // of the page's first item as a fraction of the whole document.
    const rescanTicks = () => {
      const docH = scroller.scrollHeight || 1
      const items = root.querySelectorAll(itemSelector)
      const out: number[] = []
      for (let i = 0; i < items.length; i += pageSize) {
        const el = items[i]
        if (el instanceof HTMLElement) out.push(contentTop(el) / docH)
      }
      ticks = out
      track.dataset.ticks = String(out.length)
    }

    const measure = () => {
      const rect = track.getBoundingClientRect()
      H = rect.height
      W = rect.width
      const docH = scroller.scrollHeight
      if (docH !== lastDocH) {
        lastDocH = docH
        rescanTicks()
      }
      const frac = docH <= scroller.clientHeight ? 1 : scroller.clientHeight / docH
      tgt.len = Math.max(THUMB_MIN, frac * H)
      const ms = maxScroll()
      tgt.y = ms > 0 ? (scrollPos() / ms) * (H - tgt.len) : 0
    }

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(W * dpr))
      const bh = Math.max(1, Math.round(H * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const on = track.classList.contains("is-on")
      ctx.fillStyle = getComputedStyle(canvas).color // var(--pt-faint), per theme
      // Kare 1-bit dot track: a 1px dot every 3px, x alternating by 1px (a
      // checker dither column) down the thumb lane.
      ctx.globalAlpha = on ? 0.85 : 0.5
      const cx = W - 8
      for (let y = 1, i = 0; y < H; y += 3, i++) ctx.fillRect(cx + (i % 2), y, 1, 1)
      // PAGE graduations: etched dashes + P01… labels, near-dark at rest and
      // developing while the bar is active (spec §2.3).
      ctx.globalAlpha = on ? 1 : 0.25
      for (const f of ticks) ctx.fillRect(W - 11, Math.round(f * H), 9, 1)
      if (ticks.length > 0) {
        ctx.font = '500 8px "Geist Mono", ui-monospace, monospace'
        ctx.textAlign = "right"
        ctx.textBaseline = "middle"
        ctx.globalAlpha = on ? 0.95 : 0.12
        ticks.forEach((f, i) => {
          ctx.fillText(`P${String(i + 1).padStart(2, "0")}`, W - 13, Math.round(f * H))
        })
      }
      ctx.globalAlpha = 1
    }

    const targetW = () => (hot || dragging ? THUMB_W_HOT : THUMB_W)

    const setRaf = (v: "on" | "off") => {
      if (track.dataset.raf !== v) track.dataset.raf = v
    }

    const loop = () => {
      raf = 0
      measure()
      const kp = dragging ? 1 : LERP_POS // zero damping while dragging
      cur.y += (tgt.y - cur.y) * kp
      cur.len += (tgt.len - cur.len) * LERP_LEN
      cur.w += (targetW() - cur.w) * LERP_WIDEN
      thumb.style.transform = `translateY(${cur.y.toFixed(2)}px)`
      thumb.style.height = `${cur.len.toFixed(2)}px`
      thumb.style.width = `${cur.w.toFixed(2)}px`
      track.classList.toggle("is-hot", hot || dragging)
      draw()
      const settled =
        Math.abs(tgt.y - cur.y) < 0.05 &&
        Math.abs(tgt.len - cur.len) < 0.05 &&
        Math.abs(targetW() - cur.w) < 0.05
      // F8: park once settled and 300ms past the last activity.
      if (!dragging && settled && performance.now() - lastActive > RAF_PARK_MS) {
        setRaf("off")
        return
      }
      setRaf("on")
      raf = requestAnimationFrame(loop)
    }

    const wake = () => {
      lastActive = performance.now()
      track.classList.add("is-on")
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (!dragging) track.classList.remove("is-on")
      }, IDLE_HIDE_MS)
      if (raf === 0) {
        setRaf("on")
        raf = requestAnimationFrame(loop)
      }
    }

    const setChip = (frac: number, clientY: number) => {
      if (total <= 0) return
      const idx = Math.min(total, Math.floor(frac * total) + 1)
      chip.textContent = `${idx} / ${total}`
      const rect = track.getBoundingClientRect()
      chip.style.top = `${Math.min(Math.max(clientY - 12, rect.top + 8), rect.bottom - 24)}px`
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      // A hidden bar's first contact only reveals it — a blind strip click
      // must never jump the page.
      if (!track.classList.contains("is-on")) {
        wake()
        return
      }
      measure()
      const rect = track.getBoundingClientRect()
      const y = e.clientY - rect.top
      wake()
      const ms = maxScroll()
      if (ms <= 0) return
      e.preventDefault()
      if (y >= tgt.y - GRAB_PAD && y <= tgt.y + tgt.len + GRAB_PAD) {
        dragging = true
        dragOffset = y - tgt.y
        cur.y = tgt.y // zero damping from the first frame
        cur.len = tgt.len
        track.setPointerCapture(e.pointerId)
        if (total > 0) {
          chip.classList.add("is-on")
          setChip(scrollPos() / ms, e.clientY)
        }
      } else {
        // Track click: jump so the thumb centers on the click (lenis glides).
        const frac = Math.min(1, Math.max(0, (y - tgt.len / 2) / Math.max(1, H - tgt.len)))
        writeScroll(frac * ms, false)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const rect = track.getBoundingClientRect()
      hot =
        e.clientX >= window.innerWidth - PROXIMITY_PX &&
        e.clientY >= rect.top - 12 &&
        e.clientY <= rect.bottom + 12
      if (hot) wake()
      if (!dragging) return
      const y = e.clientY - rect.top - dragOffset
      const frac = Math.min(1, Math.max(0, y / Math.max(1, H - cur.len)))
      writeScroll(frac * maxScroll(), true) // immediate: zero damping
      cur.y = Math.min(Math.max(y, 0), H - cur.len)
      setChip(frac, e.clientY)
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId)
      chip.classList.remove("is-on")
      wake()
    }

    measure()
    rescanTicks()
    cur.y = tgt.y
    cur.len = tgt.len
    wake()

    // Appends grow .bws → wake + measure, so the thumb length LERPs smaller.
    const ro = new ResizeObserver(wake)
    ro.observe(root)
    window.addEventListener("resize", wake)
    scroller.addEventListener("scroll", wake, { passive: true })
    track.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)
    return () => {
      document.documentElement.classList.remove("pt-fbar")
      ro.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      window.removeEventListener("resize", wake)
      scroller.removeEventListener("scroll", wake)
      track.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerUp)
    }
  }, [rootRef, itemSelector, pageSize, total])

  return (
    <div ref={trackRef} className="fbar" data-raf="off" aria-hidden="true">
      <canvas ref={canvasRef} className="fbar-canvas" />
      <div ref={thumbRef} className="fbar-thumb" />
      <div ref={chipRef} className="fbar-chip mono" />
    </div>
  )
}
