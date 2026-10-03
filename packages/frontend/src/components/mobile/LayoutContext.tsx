import { createContext, use, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

export interface LayoutValue {
  mobile: boolean
  compact: boolean
  width: number
}

const LayoutCtx = createContext<LayoutValue>({
  mobile: false,
  compact: false,
  width: 1280,
})

const TOUCH_MOBILE_QUERY =
  "(pointer: coarse) and (max-width: 719px), (pointer: coarse) and (max-height: 719px)"

export const LayoutProvider = ({
  width,
  children,
}: {
  width: number
  children: ReactNode
}) => {
  const [touchViewport, setTouchViewport] = useState(
    () => window.matchMedia(TOUCH_MOBILE_QUERY).matches
  )
  useEffect(() => {
    const query = window.matchMedia(TOUCH_MOBILE_QUERY)
    const update = () => setTouchViewport(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  const value = useMemo<LayoutValue>(
    () => ({
      mobile: width > 0 && (width < 720 || touchViewport),
      compact: width > 0 && width < 1040,
      width,
    }),
    [width, touchViewport]
  )
  return <LayoutCtx value={value}>{children}</LayoutCtx>
}

export const useLayout = (): LayoutValue => use(LayoutCtx)
