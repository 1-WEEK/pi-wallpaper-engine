// Settings entry — desktop gets the ticket-10 spec-ledger redesign; the
// mobile layout stays on the pre-redesign page until ticket 14 (mobile
// degradation pass), same split as Library.
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
