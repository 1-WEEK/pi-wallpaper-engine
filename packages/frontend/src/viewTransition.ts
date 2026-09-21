// Shared-element page transitions (spec §5): native View Transitions wrapped
// around a React update. Without the API — or under reduced motion (F5) — the
// update runs immediately and the swap is instant.
//
// The update callback may return a Promise (spec §5 F3): the browser then
// waits for it before capturing the new snapshot — used to let a freshly
// mounted detail <img> finish decoding so the morph never shows a blank box.
// Callers flushSync their React state themselves when they need the new DOM
// measured inside the callback (e.g. to await that decode); the returned
// promise must be created after the state has flushed.
import { prefersReducedMotion } from "./reducedMotion.js"

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<unknown>) => {
    finished: Promise<void>
  }
}

export const canViewTransition = (): boolean =>
  typeof (document as ViewTransitionDocument).startViewTransition === "function" &&
  !prefersReducedMotion()

export const withViewTransition = (
  update: () => void | Promise<unknown>
): { finished: Promise<void> } | null => {
  if (!canViewTransition()) {
    void update()
    return null
  }
  const vt = (document as ViewTransitionDocument).startViewTransition!(update)
  vt.finished.catch(() => {})
  return vt
}
