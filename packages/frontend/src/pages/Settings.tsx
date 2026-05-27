import { useState } from "react"
import type { ReactNode } from "react"
import useSWR from "swr"
import { api, type StorageStatus, type StorageTargetValidation, type SystemSummary } from "../api.js"
import { DirectoryPickerDialog } from "../components/DirectoryPickerDialog.js"
import { appIcons } from "../icons.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
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
    <div
      className={`setting-value ${mono ? "mono" : ""} ${subtle ? "setting-value-subtle" : ""}`}
    >
      {value}
    </div>
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingTargetRoot, setPendingTargetRoot] = useState<string | null>(null)
  const [targetValidation, setTargetValidation] = useState<StorageTargetValidation | null>(null)
  const [validatingTarget, setValidatingTarget] = useState(false)

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
    status.storage.error ??
    (migration?.state === "failed" ? migration.error : null)

  const validateTarget = async (path: string) => {
    setValidatingTarget(true)
    setTargetValidation(null)
    setError(null)
    try {
      const result = await api.validateStorageTarget(path)
      setTargetValidation(result)
    } catch (e) {
      setTargetValidation({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setValidatingTarget(false)
    }
  }

  const selectTargetRoot = (path: string) => {
    setPendingTargetRoot(path)
    setPickerOpen(false)
    void validateTarget(path)
  }

  const switchTargetRoot = () => {
    if (!pendingTargetRoot || targetValidation?.ok !== true || locked) return
    if (pendingTargetRoot === storage.data_root) {
      setError("Already using this directory.")
      return
    }
    if (libraryTotal > 0) {
      const ok = window.confirm(
        `Move ${libraryTotal} wallpaper(s) to the new media root? Downloads will be blocked during migration. Continue?`
      )
      if (!ok) return
    }
    void runAction("root", () => api.switchStorageRoot(pendingTargetRoot)).then(() => {
      setPendingTargetRoot(null)
      setTargetValidation(null)
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
        </div>
        <span className="status-pill mono">{storage.using_default ? "Default" : "Custom"}</span>
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

        <section className="settings-group">
          <h2 className="settings-group-title mono">Storage</h2>
          <SettingRow
            label="status"
            value={
              <StatusDot tone={storage.available ? "ok" : "off"}>
                {storage.available ? "available" : "unavailable"}
              </StatusDot>
            }
          />
          <SettingRow
            label="media root"
            value={
              <div className="storage-root-value">
                <span className="mono">{storage.data_root}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPickerOpen(true)}
                  disabled={locked}
                >
                  Change
                </button>
              </div>
            }
          />
          <SettingRow label="disk usage" value={storageCombined} />

          {pendingTargetRoot && (
            <div className="target-root-panel">
              <div className="target-root-main">
                <span className="setting-label">target root</span>
                <span className="mono target-root-path">{pendingTargetRoot}</span>
              </div>
              <div className="target-root-status">
                {validatingTarget && <span className="setting-value-subtle">checking...</span>}
                {!validatingTarget && targetValidation?.ok === true && (
                  <StatusDot tone="ok">
                    {targetValidation.message} free {formatBytes(targetValidation.free_bytes)}
                  </StatusDot>
                )}
                {!validatingTarget && targetValidation?.ok === false && (
                  <StatusDot tone="off">{targetValidation.error}</StatusDot>
                )}
              </div>
              <div className="settings-actions target-root-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={switchTargetRoot}
                  disabled={locked || validatingTarget || targetValidation?.ok !== true}
                >
                  {libraryTotal > 0 ? "Migrate here" : "Switch here"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setPendingTargetRoot(null)
                    setTargetValidation(null)
                  }}
                  disabled={locked}
                >
                  Clear
                </button>
              </div>
              {targetValidation?.ok === true && (
                <div className="setting-value-subtle">
                  {targetValidation.is_empty
                    ? "Target directory is empty and ready to use."
                    : `Target directory ${targetValidation.has_source || targetValidation.has_optimized ? "already contains media subdirectories." : "is not empty."}${libraryTotal > 0 ? " Existing wallpapers will be migrated." : ""}`}
                </div>
              )}
            </div>
          )}

          {migration && (
            <div className="migrate-status">
              {migrating && (
                <>
                  <div className="migrate-bar">
                    <div className="migrate-bar-fill" style={{ width: `${migratePct}%` }} />
                  </div>
                  <div className="migrate-line">
                    <span>
                      Migrating wallpapers… {formatBytes(migration.moved_bytes)} /{" "}
                      {formatBytes(migration.total_bytes)} ({migratePct}%)
                    </span>
                    <button
                      className="btn btn-secondary"
                      onClick={() => void runAction("cancel", api.cancelMigration)}
                      disabled={busy !== null}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
              {migration.state === "done" && (
                <div className="migrate-line setting-value-subtle">✓ Migration complete</div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="callout">
        <div className="callout-title">
          <span className="callout-title-icon">{appIcons.pi}</span>
          <span>About media root</span>
        </div>
        <p>Wallpaper source and optimized files are stored under the current media root.</p>
        <p>
          When changing roots, the app validates that the target is readable, writable, and has enough space before starting migration.
        </p>
        <p>Downloads are blocked during migration and the root cannot be changed again. If the library is empty, only the root is updated without migration.</p>
      </div>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={pendingTargetRoot ?? storage.data_root}
        disabled={locked}
        onSelect={selectTargetRoot}
      />
    </div>
  )
}
