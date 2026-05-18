import type { ReactNode } from "react"
import { appIcons } from "../../icons.js"

interface Props {
  open: boolean
  onClose: () => void
  title?: ReactNode
  action?: ReactNode
  height?: string
  children: ReactNode
}

export const MobileSheet = ({
  open,
  onClose,
  title,
  action,
  height = "88%",
  children,
}: Props) => {
  return (
    <div
      className={`mobile-sheet ${open ? "open" : ""}`}
      style={{ "--mobile-sheet-height": height } as React.CSSProperties}
      aria-hidden={!open}
    >
      <div
        className="mobile-sheet-scrim"
        onClick={onClose}
        role="presentation"
      />
      <div className="mobile-sheet-panel" role="dialog" aria-modal="true">
        <div className="mobile-sheet-grabber" aria-hidden="true" />
        {title !== undefined && title !== null && (
          <div className="mobile-sheet-header">
            <div className="mobile-sheet-title">{title}</div>
            {action}
            <button
              type="button"
              className="mobile-sheet-close"
              onClick={onClose}
              aria-label="Close"
            >
              {appIcons.close}
            </button>
          </div>
        )}
        <div className="mobile-sheet-body">{children}</div>
      </div>
    </div>
  )
}
