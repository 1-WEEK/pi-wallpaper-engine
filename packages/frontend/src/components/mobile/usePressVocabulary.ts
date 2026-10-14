// press→release vocabulary engine (mobile spec §2.1): pointerdown on a
// [data-press] control = uncommitted intent → 1px checker dither reveal,
// onset 0ms; pointerup inside the control = commit → the control's own
// click handler runs in the same frame as the reveal removal (the commit
// block / navigation / sheet open is NEVER serialized after a confirm
// beat); slide >10px slop, scroll takeover, pointercancel or leaving the
// control = cancel → the dither cuts instantly with no transition.
// `:active` flat-fill and scale-press are banned on the mobile shell; this
// engine is the only pressed-state word. Scoped to `.mobile-shell` so the
// desktop shell is untouched.
import { useEffect } from "react"
import type { RefObject } from "react"

export const PRESS_SLOP_PX = 10

interface Press {
  el: HTMLElement
  x: number
  y: number
}

const clearPress = (el: HTMLElement) => {
  // .cut kills the exit transition so a cancel/leave is a 0ms cut; the
  // forced reflow commits it before the class is dropped again.
  el.classList.add("cut")
  el.classList.remove("pressing")
  void el.offsetWidth
  el.classList.remove("cut")
}

export const usePressVocabulary = (shellRef: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const shell = shellRef.current
    if (!shell || !shell.classList.contains("mobile-shell")) return

    let press: Press | null = null

    const cancel = () => {
      if (!press) return
      clearPress(press.el)
      press = null
    }

    const onPointerDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0 || press) return
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-press]")
      if (!el || !shell.contains(el) || el.getAttribute("aria-disabled") === "true") return
      // A committed tab carries no press vocabulary (§2.1 #3).
      if (el.classList.contains("mobile-tab-bar-item") && el.classList.contains("active")) return
      press = { el, x: e.clientX, y: e.clientY }
      el.classList.add("pressing")
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!press || !e.isPrimary) return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP_PX) cancel()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!press || !e.isPrimary) return
      const { el } = press
      press = null
      if (el.getAttribute("data-press") === "card") {
        el.classList.add("committed")
        window.setTimeout(() => el.classList.remove("committed"), 140)
      }
      // The TabBar owns its press handoff (the reveal must survive until the
      // migrating block lands, §3.2 / 03 D8) — leave `.pressing` on it; the
      // bar clears it on transitionend with a 380ms fallback.
      if (el.classList.contains("mobile-tab-bar-item")) return
      clearPress(el)
    }

    // Scroll takeover is an instant cancel: listen on the capture phase of
    // any scroll inside the shell (the main scroller and sheet bodies).
    const onScroll = () => cancel()

    shell.addEventListener("pointerdown", onPointerDown, { capture: true })
    shell.addEventListener("pointermove", onPointerMove, { capture: true })
    shell.addEventListener("pointerup", onPointerUp, { capture: true })
    shell.addEventListener("pointercancel", cancel, { capture: true })
    shell.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => {
      shell.removeEventListener("pointerdown", onPointerDown, { capture: true })
      shell.removeEventListener("pointermove", onPointerMove, { capture: true })
      shell.removeEventListener("pointerup", onPointerUp, { capture: true })
      shell.removeEventListener("pointercancel", cancel, { capture: true })
      shell.removeEventListener("scroll", onScroll, { capture: true })
    }
  }, [shellRef])
}
