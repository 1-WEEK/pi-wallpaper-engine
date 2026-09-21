// Cross-page ghost choreography (ticket 12, spec §4.5 — the two flights that
// cross page boundaries; same-page card → detail stays on View Transitions):
//
// 1. Download receipt: Browse ADD flies the thumbnail (420ms, registered §5
//    exception) into the Library nav item — "it went there" — and once the
//    ghost lands, the nav label flashes inverse for 1.4s (navpulse, §5
//    exception 700×2+1400). The actual library insert is the existing
//    download/backend/SWR reality; this module only owns the motion.
// 2. Library PLAY → the card media flies (380ms, registered §5 exception)
//    into the PlayerBar thumb slot as playback starts.
//
// Both run through the shared transform-FLIP flyGhost on a dedup channel, so
// rapid re-triggers replace the in-flight ghost instead of stacking. Reduced
// motion (§5 F5): no ghost, no pulse — the state change itself still happens.
import { flyGhost } from "./ghost.js"
import { duration } from "./motionTokens.js"
import { prefersReducedMotion } from "./reducedMotion.js"

/** The Library nav item — the download receipt's landing pad. */
const libraryNavEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.rail-nav-link[data-nav="library"]')

const playerThumbEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".pbar-thumb")

let pulseTimer: number | null = null

/** navpulse (§5 exception): the nav label flashes inverse once, 1.4s. It hangs
 *  on the label, not the link, so it never fights the XOR mask's covered
 *  state (ticket 11). Class-based: a repeat re-arms the animation from zero. */
const pulseLibraryNav = () => {
  const link = libraryNavEl()
  if (!link) return
  link.classList.remove("nav-pulse")
  void link.offsetWidth // restart the CSS animation on rapid repeats
  link.classList.add("nav-pulse")
  if (pulseTimer !== null) window.clearTimeout(pulseTimer)
  pulseTimer = window.setTimeout(() => {
    link.classList.remove("nav-pulse")
    pulseTimer = null
  }, 1450)
}

/** Browse ADD receipt: the card media flies into the Library nav item as a
 *  48×30 chip; the landing fires the navpulse receipt flash. */
export const flyDownloadReceipt = (fromEl: HTMLElement, src?: string): void => {
  if (prefersReducedMotion()) return
  const nav = libraryNavEl()
  if (!nav) return
  const to = nav.getBoundingClientRect()
  flyGhost({
    from: fromEl.getBoundingClientRect(),
    to: new DOMRect(to.left + to.width / 2 - 24, to.top + to.height / 2 - 15, 48, 30),
    src,
    duration: duration.ghostLong, // 420ms — registered §5 exception
    toRadius: "3px",
    channel: "download-receipt",
    onDone: pulseLibraryNav,
  })
}

/** Library PLAY: the card media flies into the PlayerBar thumb slot while the
 *  play intent and the now-playing switch run on the existing API path. */
export const flyPlayGhost = (fromEl: HTMLElement | null | undefined, src?: string): void => {
  if (!fromEl || prefersReducedMotion()) return
  const thumb = playerThumbEl()
  if (!thumb) return
  flyGhost({
    from: fromEl.getBoundingClientRect(),
    to: thumb.getBoundingClientRect(),
    src,
    duration: duration.ghostPlayer, // 380ms — registered §5 exception
    toRadius: "6px",
    channel: "play",
  })
}
