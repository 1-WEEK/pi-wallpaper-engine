import type { SystemSummary } from "../api.js"
import { appIcons } from "../icons.js"

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
}: {
  label: string
  value: string
  mono?: boolean
}) => (
  <div className="setting-row">
    <span className="setting-label">{label}</span>
    <span className={mono ? "mono" : undefined}>{value}</span>
  </div>
)

export const Settings = ({ summary }: Props) => {
  if (!summary) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <div className="page-kicker mono">Runtime summary</div>
            <h1 className="page-title">Settings</h1>
          </div>
        </header>
        <div className="empty-state">Loading Pi configuration…</div>
      </div>
    )
  }

  const { config, status } = summary

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-kicker mono">Read-only runtime configuration</div>
          <h1 className="page-title">Settings</h1>
        </div>
        <div className="status-pill">Edit on Pi</div>
      </header>

      <div className="settings-grid">
        <section className="settings-group">
          <h2 className="settings-group-title mono">Steam</h2>
          <SettingRow label="username" value={config.steam.username} />
          <SettingRow label="web api key" value={config.steam.web_api_key_masked} mono />
          <SettingRow label="steamcmd" value={config.steam.steamcmd_path} mono />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">Storage</h2>
          <SettingRow label="data root" value={status.storage.path} mono />
          <SettingRow label="used" value={formatBytes(status.storage.used_bytes)} />
          <SettingRow label="free" value={formatBytes(status.storage.free_bytes)} />
          <SettingRow
            label="capacity"
            value={
              status.storage.used_percent !== null
                ? `${status.storage.used_percent.toFixed(1)}%`
                : "Unavailable"
            }
          />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">Display</h2>
          <SettingRow
            label="screen"
            value={`${config.screen.width} × ${config.screen.height}`}
            mono
          />
          <SettingRow label="default mode" value={config.screen.default_display_mode} mono />
          <SettingRow
            label="display power"
            value={status.display.configured ? status.display.state : "Not configured"}
          />
          <SettingRow
            label="server"
            value={`${config.server.host}:${config.server.port}`}
            mono
          />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">mpv</h2>
          <SettingRow label="binary" value={config.mpv.binary_path} mono />
          <SettingRow label="ipc socket" value={config.mpv.ipc_socket} mono />
          <SettingRow label="hwdec" value={config.mpv.hwdec} mono />
          <SettingRow label="gpu api" value={config.mpv.gpu_api} mono />
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
