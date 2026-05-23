import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import useSWR from "swr"
import { api, type StorageStatus, type SystemSummary } from "../api.js"
import { appIcons } from "../icons.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

interface SmbFormState {
  server: string
  share: string
  username: string
  password: string
}

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "Unavailable"
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const modeLabel = (mode: StorageStatus["mode"]): string =>
  mode === "local" ? "本机 SD 卡" : "网络存储"

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

export const Settings = ({ summary, onRefresh }: Props) => {
  const { data: storage, mutate: mutateStorage } = useSWR("storage", api.getStorage, {
    refreshInterval: (data) => (data?.migration?.state === "running" ? 1000 : 5000),
    revalidateIfStale: true,
  })
  const [form, setForm] = useState<SmbFormState>({
    server: "",
    share: "",
    username: "",
    password: "",
  })
  const [seeded, setSeeded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Seed the form from saved SMB config once, so background polling does not
  // overwrite what the user is typing.
  useEffect(() => {
    if (storage?.smb && !seeded) {
      setForm({
        server: storage.smb.server,
        share: storage.smb.share,
        username: storage.smb.username,
        password: "",
      })
      setSeeded(true)
    }
  }, [storage?.smb, seeded])

  const runAction = async (label: string, action: () => Promise<StorageStatus>) => {
    setBusy(label)
    setError(null)
    try {
      const next = await action()
      await mutateStorage(next, { revalidate: false })
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!summary || !storage) {
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
  const libraryTotal = status.library.total

  const migration = storage.migration
  const migrating = migration?.state === "running"
  const locked = busy !== null || migrating
  const migratePct = migration
    ? Math.min(100, Math.round((migration.moved_bytes / Math.max(1, migration.total_bytes)) * 100))
    : 0
  const banner =
    error ??
    storage.last_error ??
    (migration?.state === "failed" ? migration.error : null)

  const switchMode = (mode: "local" | "mounted_share") => {
    if (mode === storage.mode || locked) return
    if (mode === "mounted_share" && !storage.smb) {
      setError("请先填写并保存网络存储设置。")
      return
    }
    if (libraryTotal > 0) {
      const ok = window.confirm(
        `将移动 ${libraryTotal} 个壁纸到新的存储位置,迁移期间无法下载新壁纸。确定继续?`
      )
      if (!ok) return
    }
    void runAction("mode", () => api.updateStorage({ mode, smb: null }))
  }

  const saveSmb = () => {
    if (!form.server.trim() || !form.share.trim() || !form.username.trim()) {
      setError("请填写网络地址、共享名和用户名。")
      return
    }
    void runAction("save", () =>
      api.updateStorage({
        mode: storage.mode,
        smb: {
          server: form.server.trim(),
          share: form.share.trim(),
          username: form.username.trim(),
          password: form.password.trim() ? form.password : null,
        },
      })
    ).then(() => setForm((current) => ({ ...current, password: "" })))
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
        </div>
        <span className="status-pill mono">{modeLabel(storage.mode)}</span>
      </header>

      {banner && <div className="error-banner">{banner}</div>}

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

      <section className="settings-group">
        <h2 className="settings-group-title mono">存储位置</h2>

        <SettingRow
          label="壁纸文件存放"
          value={
            <div className="segmented segmented-compact">
              <button
                className={`segmented-button ${storage.mode === "local" ? "active" : ""}`}
                onClick={() => switchMode("local")}
                disabled={locked}
              >
                本机 SD 卡
              </button>
              <button
                className={`segmented-button ${storage.mode === "mounted_share" ? "active" : ""}`}
                onClick={() => switchMode("mounted_share")}
                disabled={locked}
              >
                网络存储
              </button>
            </div>
          }
        />
        <SettingRow
          label="状态"
          value={
            <StatusDot tone={storage.available ? "ok" : "off"}>
              {storage.available ? "可用" : "不可用"}
            </StatusDot>
          }
        />
        <SettingRow label="数据目录" value={storage.data_root} mono />
        <SettingRow label="磁盘占用" value={storageCombined} />

        {migration && (
          <div className="migrate-status">
            {migrating && (
              <>
                <div className="migrate-bar">
                  <div className="migrate-bar-fill" style={{ width: `${migratePct}%` }} />
                </div>
                <div className="migrate-line">
                  <span>
                    正在迁移壁纸… {formatBytes(migration.moved_bytes)} /{" "}
                    {formatBytes(migration.total_bytes)} ({migratePct}%)
                  </span>
                  <button
                    className="btn btn-secondary"
                    onClick={() => void runAction("cancel", api.cancelMigration)}
                    disabled={busy !== null}
                  >
                    取消
                  </button>
                </div>
              </>
            )}
            {migration.state === "done" && (
              <div className="migrate-line setting-value-subtle">✓ 壁纸已迁移完成</div>
            )}
          </div>
        )}

        <div className="storage-form-grid">
          <label className="storage-field">
            <span className="setting-label">网络地址</span>
            <input
              value={form.server}
              onChange={(event) => setForm((current) => ({ ...current, server: event.target.value }))}
              placeholder="192.168.1.10"
              disabled={locked}
            />
          </label>
          <label className="storage-field">
            <span className="setting-label">共享名</span>
            <input
              value={form.share}
              onChange={(event) => setForm((current) => ({ ...current, share: event.target.value }))}
              placeholder="wallpapers"
              disabled={locked}
            />
          </label>
          <label className="storage-field">
            <span className="setting-label">用户名</span>
            <input
              value={form.username}
              onChange={(event) =>
                setForm((current) => ({ ...current, username: event.target.value }))
              }
              disabled={locked}
            />
          </label>
          <label className="storage-field">
            <span className="setting-label">密码</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) =>
                setForm((current) => ({ ...current, password: event.target.value }))
              }
              placeholder={storage.smb?.has_password ? "已保存,留空则不变" : ""}
              disabled={locked}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={saveSmb} disabled={locked}>
            保存网络存储设置
          </button>
        </div>
      </section>

      <div className="callout">
        <div className="callout-title">
          <span className="callout-title-icon">{appIcons.pi}</span>
          <span>关于网络存储</span>
        </div>
        <p>
          网络存储让壁纸文件存放在 NAS 等设备上,而不是占用本机 SD 卡。切换存放位置时,
          已下载的壁纸会自动迁移到新位置,期间请勿断电。
        </p>
      </div>
    </div>
  )
}
