import type { ReactNode } from "react"
import type { SystemSummary } from "../api.js"
import { appIcons } from "../icons.js"
import { useLayout } from "../components/mobile/index.js"

interface Props {
  summary: SystemSummary | null
}

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "Unavailable"
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const SettingRow = ({
  label,
  value,
  mono = false,
  subtle = false,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  subtle?: boolean
}) => (
  <div className="setting-row">
    <span className="setting-label">{label}</span>
    <span
      className={`setting-value ${mono ? "mono" : ""} ${subtle ? "setting-value-subtle" : ""}`}
    >
      {value}
    </span>
  </div>
)

const StatusDot = ({
  tone,
  children,
}: {
  tone: "ok" | "off"
  children: ReactNode
}) => (
  <span className={`setting-status setting-status-${tone}`}>
    <span className="setting-status-dot" aria-hidden="true" />
    {children}
  </span>
)

export const Settings = ({ summary }: Props) => {
  const { mobile } = useLayout()

  if (!summary) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Settings</h1>
          </div>
        </header>
        <div className="empty-state">Loading Pi configuration…</div>
      </div>
    )
  }

  const { config, status } = summary
  const usedPct =
    status.storage.used_percent !== null ? `(${status.storage.used_percent.toFixed(0)}%)` : ""
  const storageCombined =
    status.storage.used_bytes !== null && status.storage.total_bytes !== null
      ? `${formatBytes(status.storage.used_bytes)} / ${formatBytes(status.storage.total_bytes)} ${usedPct}`.trim()
      : "Unavailable"
  const signedIn = !!config.steam.username
  const mpvUp = !!status.player

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
        </div>
        <span className="status-pill status-pill-readonly mono">
          {mobile ? "read-only" : "read-only · edit config.json on Pi"}
        </span>
      </header>

      <div className="settings-grid">
        <section className="settings-group">
          <h2 className="settings-group-title mono">Steam credentials</h2>
          <SettingRow label="username" value={config.steam.username} mono />
          <SettingRow
            label="login state"
            value={
              signedIn ? (
                <StatusDot tone="ok">authenticated</StatusDot>
              ) : (
                <StatusDot tone="off">not signed in</StatusDot>
              )
            }
          />
          <SettingRow label="api key" value={config.steam.web_api_key_masked} mono />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">Storage</h2>
          <SettingRow label="data root" value={status.storage.path} mono />
          <SettingRow label="used" value={storageCombined} />
          <SettingRow
            label="nas mount"
            value={status.storage.available ? "available" : "not configured"}
            subtle={!status.storage.available}
          />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">Display</h2>
          <SettingRow
            label="screen"
            value={`${config.screen.width} × ${config.screen.height}`}
            mono
          />
          <SettingRow
            label="default mode"
            value={config.screen.default_display_mode}
            mono
          />
          <SettingRow
            label="power"
            value={
              status.display.configured ? (
                <StatusDot tone={status.display.state === "on" ? "ok" : "off"}>
                  {status.display.state}
                </StatusDot>
              ) : (
                <span className="setting-value-subtle">not configured</span>
              )
            }
          />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">mpv</h2>
          <SettingRow label="hwdec" value={config.mpv.hwdec} mono />
          <SettingRow label="gpu api" value={config.mpv.gpu_api} mono />
          <SettingRow
            label="status"
            value={
              mpvUp ? (
                <StatusDot tone="ok">process up</StatusDot>
              ) : (
                <StatusDot tone="off">down</StatusDot>
              )
            }
          />
        </section>
      </div>

      <div className="callout">
        <div className="callout-title">
          <span className="callout-title-icon">{appIcons.pi}</span>
          <span>Apply changes</span>
        </div>
        <p>
          Edit <code>config.json</code> on the Pi, then restart the backend to load the new values.
        </p>
        <pre className="callout-code mono">$ systemctl --user restart pi-wallpaper-engine</pre>
      </div>
    </div>
  )
}
