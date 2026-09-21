// Reduced-motion gate (spec §5 F5): per-element degradation, reduce ≠ remove.
// CSS keeps opacity/color transitions on its own; every JS-driven effect
// (lenis, ghosts, view transitions) consults this module before initializing.
import { useEffect, useState } from "react"

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches

export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setReduced(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  return reduced
}
