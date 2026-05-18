import { useLayoutEffect, useRef, useState } from "react"
import type { RefObject } from "react"

export const useContainerWidth = (): [RefObject<HTMLDivElement>, number] => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth : 1280
  )

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, width]
}
