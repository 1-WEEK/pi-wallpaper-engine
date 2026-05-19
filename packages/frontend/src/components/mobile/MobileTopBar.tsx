import type { SystemSummary } from "../../api.js"

interface Props {
  title: string
  summary: SystemSummary | null
}

export const MobileTopBar = ({ title, summary }: Props) => {
  const player = summary?.status.player ?? null
  const mpvUp = !!player
  return (
    <header className="mobile-top-bar">
      <img src="/favicon.svg" alt="" className="mobile-top-bar-logo" width={28} height={28} />
      <div className="mobile-top-bar-copy">
        <div className="mobile-top-bar-title">{title}</div>
        <div className="mobile-top-bar-subtitle mono">
          pi.local ·{" "}
          <span className={`mobile-top-bar-status ${mpvUp ? "ok" : "off"}`}>
            <span className="mobile-top-bar-dot" aria-hidden="true" />
            {mpvUp ? "mpv up" : "mpv down"}
          </span>
        </div>
      </div>
    </header>
  )
}
