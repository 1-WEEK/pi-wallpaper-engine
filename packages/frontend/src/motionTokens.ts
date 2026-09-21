// JS mirrors of the motion tokens in tokens.css (spec §5). WAAPI and motion
// consume easing as strings, so the canonical curves live here for TS code;
// keep values in sync with --ease-out / --ease-slide and the duration scale.
export const easeOut = "cubic-bezier(0.16, 1, 0.3, 1)"
export const easeSlide = "cubic-bezier(0.4, 0, 0.2, 1)"

export const duration = {
  /** Micro feedback. */
  micro: 120,
  /** Popover exit, chips. */
  exit: 150,
  /** Hover, overlay enter (180–250 band). */
  hover: 200,
  /** View Transition / ghost baseline. */
  base: 300,
  /** Long-range cross-page ghost (also the 09 nav mask slide). */
  ghostLong: 420,
} as const

/** Stagger per item, capped at 8 items (spec §5). */
export const staggerStep = 40
export const staggerCap = 8
export const staggerDelay = (index: number): number =>
  Math.min(index, staggerCap) * staggerStep
