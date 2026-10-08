// Reduce-transparency degradation engine (mobile spec §2.3): the final
// glass state is NOT(manual switch OR prefers-reduced-transparency OR
// prefers-reduced-motion) — any channel flips the shell into the opaque
// mode (`html[data-reduce-transparency="true"]`): MiniPlayer → solid
// `--pt-bg` + top hairline; focused overlays → solid + --pt-line border;
// scrims unchanged. The iOS "reduce transparency" toggle is not exposed
// to the web, so prefers-reduced-motion is borrowed as the system-level
// proxy (registered approximation, spec §2.3 channel ②).
import { useSyncExternalStore } from "react"

export const REDUCE_TRANSPARENCY_KEY = "pwe-reduce-transparency"

const RT_QUERY = "(prefers-reduced-transparency: reduce)"
const RM_QUERY = "(prefers-reduced-motion: reduce)"

let listeners: Array<() => void> = []
const subscribeMedia = (() => {
  let wired = false
  return () => {
    if (wired || typeof window === "undefined") return
    wired = true
    const notify = () => listeners.forEach((l) => l())
    window.matchMedia(RT_QUERY).addEventListener("change", notify)
    window.matchMedia(RM_QUERY).addEventListener("change", notify)
    window.addEventListener("storage", notify)
  }
})()

export const reduceTransparencyActive = (): boolean => {
  if (typeof window === "undefined") return false
  return (
    window.localStorage.getItem(REDUCE_TRANSPARENCY_KEY) === "1" ||
    window.matchMedia(RT_QUERY).matches ||
    window.matchMedia(RM_QUERY).matches
  )
}

export const setReduceTransparency = (on: boolean): void => {
  window.localStorage.setItem(REDUCE_TRANSPARENCY_KEY, on ? "1" : "0")
  listeners.forEach((l) => l())
}

export const useReduceTransparency = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      subscribeMedia()
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
    reduceTransparencyActive
  )
