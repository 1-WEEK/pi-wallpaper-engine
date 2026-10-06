// TopBar (mobile spec §3.1): typographic skeleton strip — the `pwe+`
// wordmark is the logo (favicon img deleted), the repeated page title is
// deleted (the 26px Clash page head owns the display title, §6 D8), and a
// mono instrument readout sits right. Opaque --pt-bg page skeleton, never
// glass (§2.3). Theme controls are NOT here — they belong to Settings.
import type { SystemSummary } from "../../api.js"

interface Props {
  summary: SystemSummary | null
}

export const MobileTopBar = ({ summary }: Props) => {
  const mpvUp = !!summary?.status.player
  return (
    <header className="mobile-top-bar">
      <span className="mobile-top-bar-word" aria-label="Pi Wallpaper Engine">
        <span className="mobile-top-bar-word-w">pwe</span>
        <span className="mobile-top-bar-word-x" aria-hidden="true">
          +
        </span>
      </span>
      <span className="mobile-top-bar-status mono">
        PI.LOCAL&nbsp;·&nbsp;MPV&nbsp;
        <b className={mpvUp ? "up" : undefined}>
          ●&nbsp;{mpvUp ? "UP" : "DOWN"}
        </b>
      </span>
    </header>
  )
}
