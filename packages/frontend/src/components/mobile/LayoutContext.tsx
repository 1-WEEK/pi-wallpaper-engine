import { createContext, useContext, useMemo } from "react"
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

export const LayoutProvider = ({
  width,
  children,
}: {
  width: number
  children: ReactNode
}) => {
  const value = useMemo<LayoutValue>(
    () => ({
      mobile: width > 0 && width < 720,
      compact: width > 0 && width < 1040,
      width,
    }),
    [width]
  )
  return <LayoutCtx.Provider value={value}>{children}</LayoutCtx.Provider>
}

export const useLayout = (): LayoutValue => useContext(LayoutCtx)
