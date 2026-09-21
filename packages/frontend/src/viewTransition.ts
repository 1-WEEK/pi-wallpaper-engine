// Shared-element page transitions (spec §5): native View Transitions wrapped
// around a flushSync'd React update. Without the API — or under reduced
// motion (F5) — the update runs immediately and the swap is instant.
import { flushSync } from "react-dom"
import { prefersReducedMotion } from "./reducedMotion.js"

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<unknown>) => {
    finished: Promise<void>
  }
}

export const canViewTransition = (): boolean =>
  typeof (document as ViewTransitionDocument).startViewTransition === "function" &&
  !prefersReducedMotion()

export const withViewTransition = (update: () => void): { finished: Promise<void> } | null => {
  if (!canViewTransition()) {
    update()
    return null
  }
  const vt = (document as ViewTransitionDocument).startViewTransition!(() => {
    flushSync(update)
  })
  vt.finished.catch(() => {})
  return vt
}
