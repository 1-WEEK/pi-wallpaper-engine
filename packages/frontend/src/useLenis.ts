// Lenis inertial scrolling (spec §2.5: lerp 0.09) bound to the shell's
// content scroller. The rAF loop owns the instance; React state is never
// touched per frame. Reduced motion (spec §5 F5): lenis is not initialized
// at all and the scroller keeps plain native scrolling.
import Lenis from "lenis"
import { useEffect, type RefObject } from "react"
import { prefersReducedMotion } from "./reducedMotion.js"

// The live desktop lenis instance, exposed for the Browse functional
// scrollbar (ticket 07): it reads `animatedScroll` and writes drags back
// through `scrollTo`. Null under reduced motion (lenis never initializes)
// and on the mobile shell.
let activeLenis: Lenis | null = null

export const getLenis = (): Lenis | null => activeLenis

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
      // wrapper === content: lenis's cached Dimensions can never see growth —
      // its ResizeObservers watch the wrapper box, which doesn't change when
      // only scrollHeight does, and observing firstElementChild instead leaves
      // the limit frozen after an SPA route swap (the observed node detaches),
      // killing wheel scrolling and clamping scrollbar drags at a stale limit.
      // Naive dimensions read scrollHeight/clientHeight live on every access.
      naiveDimensions: true,
    })
    activeLenis = lenis

    let raf = 0
    const tick = (time: number) => {
      lenis.raf(time)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      activeLenis = null
      lenis.destroy()
    }
  }, [scrollerRef])
}
