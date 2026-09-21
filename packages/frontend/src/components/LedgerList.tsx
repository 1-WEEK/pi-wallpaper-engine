// LedgerList — the density-list row grammar (spec §2.3 / §4.1): N° index,
// 56px thumb, title left, dotted leader, mono metadata right, hairline
// separators between rows. Extracted as a shared component so ticket 08
// (Library List) reuses the exact same syntax; per-page extras (badges,
// action chips) slot in via `action`.
import type { ReactNode } from "react"

export const LedgerList = ({ children }: { children: ReactNode }) => (
  <div className="ledger-list" role="listbox" aria-label="Density list">
    {children}
  </div>
)

export const LedgerRow = ({
  no,
  title,
  meta,
  thumb,
  cursor = false,
  action,
  onSelect,
  onOpen,
}: {
  /** Zero-padded index readout, e.g. "001". */
  no: string
  /** Row title; a ReactNode lets callers append chips (e.g. NOW PLAYING). */
  title: ReactNode
  /** Right-aligned mono metadata readout. */
  meta: string
  thumb?: string | null
  /** True while the keyboard cursor sits on this row. */
  cursor?: boolean
  /** Optional trailing slot (badges / action chips). */
  action?: ReactNode
  onSelect?: () => void
  onOpen?: () => void
}) => (
  <div
    className={`ledger-row${cursor ? " is-cursor" : ""}`}
    role="option"
    aria-selected={cursor}
    onClick={onSelect}
    onDoubleClick={onOpen}
  >
    <span className="ledger-no mono">N°{no}</span>
    {thumb ? (
      <img className="ledger-thumb" src={thumb} alt="" loading="lazy" />
    ) : (
      <span className="ledger-thumb ledger-thumb-empty" aria-hidden="true" />
    )}
    <span className="ledger-title" title={typeof title === "string" ? title : undefined}>
      {title}
    </span>
    <span className="ledger-leader" aria-hidden="true" />
    <span className="ledger-meta mono">{meta}</span>
    {action}
  </div>
)
