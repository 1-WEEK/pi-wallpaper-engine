// Settings entry — desktop gets the ticket-10 spec-ledger redesign; mobile
// gets the ticket-14 two-layer degradation (section list → detail) over the
// same section bodies, same split as Library.
import type { SystemSummary } from "@pwe/shared"
import { useLayout } from "../components/mobile/index.js"
import { SettingsDesktop } from "./SettingsDesktop.js"
import { SettingsMobile } from "./SettingsMobile.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

export const Settings = (props: Props) => {
  const { mobile } = useLayout()
  return mobile ? <SettingsMobile {...props} /> : <SettingsDesktop {...props} />
}
