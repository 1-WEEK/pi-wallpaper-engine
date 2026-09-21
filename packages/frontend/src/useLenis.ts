// Lenis inertial scrolling (spec §2.5: lerp 0.09) bound to the shell's
// content scroller. The rAF loop owns the instance; React state is never
// touched per frame. Reduced motion (spec §5 F5): lenis is not initialized
// at all and the scroller keeps plain native scrolling.
import Lenis from "lenis"
import { useEffect, type RefObject } from "react"
import { prefersReducedMotion } from "./reducedMotion.js"

export const useLenis = (scrollerRef: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || prefersReducedMotion()) return

    // content === scroller: the scroller's own scrollHeight always reflects
    // the current page, so route swaps can't leave lenis reading a detached
    // content node.
    const lenis = new Lenis({
      wrapper: scroller,
      content: scroller,
      lerp: 0.09,
      smoothWheel: true,
    })

    let raf = 0
    const tick = (time: number) => {
      lenis.raf(time)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      lenis.destroy()
    }
  }, [scrollerRef])
}
