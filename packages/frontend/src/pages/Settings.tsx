import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import useSWR from "swr"
import { api, type StorageStatus, type StorageTargetValidation, type SystemSummary } from "../api.js"
import { DirectoryPickerDialog } from "../components/DirectoryPickerDialog.js"
import { appIcons } from "../icons.js"
import {
  deletePasskey,
  fetchSetupState,
  listPasskeys,
  registerPasskey,
  signOut,
  type PasskeyRecord,
} from "../auth.js"
import { dispatchAuthChange } from "../api.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

const SLEEP_PRESETS = [0, 15, 30, 60, 120] as const

const ROTATION_PRESETS = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "10m", sec: 600 },
  { label: "30m", sec: 1800 },
] as const

const formatSleepCountdown = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

const passkeyDateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
})

const formatPasskeyDate = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return passkeyDateFmt.format(date)
}

const PasskeySection = () => {
  const { data: setupState } = useSWR("auth-setup-state", fetchSetupState)
  const {
    data: passkeys,
    error,
    isLoading,
    mutate,
  } = useSWR<PasskeyRecord[]>(setupState?.enabled ? "auth-passkeys" : null, listPasskeys)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!setupState?.enabled) return null

  const maxKeys = setupState.max_passkeys ?? 3
  const count = passkeys?.length ?? 0
  const atLimit = count >= maxKeys

  const onAdd = async () => {
    setBusy("add")
    setActionError(null)
    try {
      await registerPasskey(`Passkey ${count + 1}`)
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onDelete = async (id: string) => {
    setBusy(id)
    setActionError(null)
    try {
      await deletePasskey(id)
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-group">
      <h2 className="settings-group-title mono">Passkeys</h2>
      <SettingRow
        label="status"
        value={
          <span className="setting-value-subtle">
            {count} of {maxKeys} registered
          </span>
        }
      />
      {isLoading && <SettingRow label="loading" value={<span className="setting-value-subtle">…</span>} />}
      {error && <SettingRow label="error" value={<StatusDot tone="off">{String(error.message ?? error)}</StatusDot>} />}
      {passkeys?.map((pk) => (
        <SettingRow
          key={pk.id}
          label={pk.name || "Unnamed"}
          value={
            <div className="storage-root-value">
              <span className="setting-value-subtle">{formatPasskeyDate(pk.createdAt)}</span>
              <button
                type="button"
                className="btn btn-row btn-row-quiet"
                onClick={() => void onDelete(pk.id)}
                disabled={busy !== null || count <= 1}
                title={count <= 1 ? "Cannot remove your last passkey" : undefined}
              >
                {busy === pk.id ? "Removing…" : "Remove"}
              </button>
            </div>
          }
        />
      ))}
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onAdd()}
          disabled={busy !== null || atLimit}
        >
          {busy === "add" ? "Waiting for passkey…" : atLimit ? `Limit reached (${maxKeys})` : "Add passkey"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={async () => {
            setBusy("signout")
            try {
              await signOut()
              dispatchAuthChange()
            } finally {
              setBusy(null)
            }
          }}
          disabled={busy !== null}
        >
          {busy === "signout" ? "Signing out…" : "Sign out"}
        </button>
      </div>
      {actionError && <div className="error-banner">{actionError}</div>}
    </section>
  )
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
  const [sleepBusy, setSleepBusy] = useState(false)
  const [intervalBusy, setIntervalBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const sleepActive = summary?.status.sleep.active ?? false
  useEffect(() => {
    if (!sleepActive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [sleepActive])

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

  const handleSleep = async (minutes: number) => {
    setSleepBusy(true)
    setError(null)
    try {
      await api.setSleep(minutes)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSleepBusy(false)
    }
  }

  const handleInterval = async (seconds: number) => {
    setIntervalBusy(true)
    setError(null)
    try {
      await api.setRotationInterval(seconds)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIntervalBusy(false)
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
          <h2 className="settings-group-title mono">Sleep timer</h2>
          <SettingRow
            label="auto-off"
            value={
              <div className="segmented segmented-compact">
                {SLEEP_PRESETS.map((min) => (
                  <button
                    key={min}
                    type="button"
                    className="segmented-button"
                    disabled={sleepBusy}
                    onClick={() => void handleSleep(min)}
                  >
                    {min === 0 ? "Off" : `${min}m`}
                  </button>
                ))}
              </div>
            }
          />
          <SettingRow
            label="state"
            value={
              status.sleep.active && status.sleep.deadline ? (
                <StatusDot tone="ok">
                  off in {formatSleepCountdown(status.sleep.deadline - now)}
                </StatusDot>
              ) : (
                <span className="setting-value-subtle">inactive</span>
              )
            }
          />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-title mono">Rotation interval</h2>
          <SettingRow
            label="every"
            value={
              <div className="segmented segmented-compact">
                {ROTATION_PRESETS.map(({ label, sec }) => (
                  <button
                    key={sec}
                    type="button"
                    className={`segmented-button ${status.player.rotation_interval_sec === sec ? "active" : ""}`}
                    disabled={intervalBusy}
                    onClick={() => void handleInterval(sec)}
                  >
                    {label}
                  </button>
                ))}
              </div>
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

        <PasskeySection />

        <section className="settings-group settings-group-wide">
          <header className="settings-group-header">
            <h2 className="settings-group-title mono">Storage</h2>
            {!storage.using_default && (
              <span className="settings-tag mono">custom root</span>
            )}
          </header>
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
                <span className="mono storage-root-path">{storage.data_root}</span>
                <button
                  type="button"
                  className="btn btn-row"
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

          <p className="settings-note">
            <span className="settings-note-icon" aria-hidden="true">{appIcons.pi}</span>
            <span>
              Wallpaper source and optimized files live under the current media root.
              Switching roots validates space and migrates the library; downloads pause
              until migration completes.
            </span>
          </p>
        </section>
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
