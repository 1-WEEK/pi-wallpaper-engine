// Settings desktop (implementation ticket 10) — spec §4.4 IA + the 05
// prototype's unified spec-ledger row grammar. Four local sections live in
// the rail: Playback / Storage / Access & Security primary, System under a
// hairline as the secondary diagnostic entry (with a `!` badge when a
// health row warns). Sections are URL-addressable via ?sec= with
// back-button support, defaulting to playback. No overview page, no global
// save, no "advanced" — per-item immediate commit: controls derive their
// value from the server summary and only the in-flight target is local
// state, so a failed commit reverts to the server's actual value by
// construction. The directory-change focused flow is the page's only glass
// surface (§2.4); the migration itself is handed to Activity (§4.3), which
// owns phases, errors and cancel.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useSearch } from "wouter"
import useSWR from "swr"
import type { SystemSummary } from "@pwe/shared"
import {
  api,
  dispatchAuthChange,
  type StorageDirectoryEntry,
  type StorageLocation,
  type StorageStatus,
  type StorageTargetValidation,
} from "../api.js"
import {
  deletePasskey,
  fetchSetupState,
  listPasskeys,
  registerPasskey,
  signOut,
} from "../auth.js"
import { RailControls } from "../components/RailShell.js"
import { StateBlock } from "../components/StateBlock.js"
import { getInterfaceSounds, setInterfaceSounds } from "../interfaceSounds.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

type Sec = "playback" | "storage" | "access" | "system"

const normalizeSec = (raw: string | null): Sec =>
  raw === "storage" || raw === "access" || raw === "system" ? raw : "playback"

const HEAD_TITLE: Record<Sec, string> = {
  playback: "Playback",
  storage: "Storage",
  access: "Access",
  system: "System",
}

/* ── The one row grammar (spec §4.4): sans name left (14px) + dotted
   leader + mono value right (11px) + hairline below. Identities: command
   rows carry → and a hover band; read-only rows stay quiet. ─────────── */

const SpecRow = ({
  name,
  val,
  cmd = false,
  warn = false,
  onClick,
  href,
  disabled = false,
  children,
}: {
  name: ReactNode
  val?: ReactNode
  cmd?: boolean
  warn?: boolean
  onClick?: () => void
  href?: string
  disabled?: boolean
  children?: ReactNode
}) => {
  const inner = (
    <>
      <span className="set-row-name">{name}</span>
      <span className="set-row-dots" aria-hidden="true" />
      {children ?? (
        <span className={`set-row-val mono${warn ? " set-warn" : ""}${cmd ? " set-row-arrow" : ""}`}>
          {val}
        </span>
      )}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="set-row set-row-btn set-row-cmd">
        {inner}
      </Link>
    )
  }
  if (!onClick) return <div className="set-row">{inner}</div>
  return (
    <button
      type="button"
      className={`set-row set-row-btn${cmd ? " set-row-cmd" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {inner}
    </button>
  )
}

const Note = ({ warn = false, children }: { warn?: boolean; children: ReactNode }) => (
  <div className={`set-note mono${warn ? " set-warn" : ""}`}>{children}</div>
)

/** Full-width hairline capacity/progress bar (spec §4.4). */
const CapBar = ({ pct }: { pct: number }) => (
  <div className="set-cap">
    <span
      className="set-cap-fill"
      style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }}
    />
  </div>
)

const Block = ({
  label,
  action,
  children,
}: {
  label: ReactNode
  action?: ReactNode
  children: ReactNode
}) => (
  <section className="set-block">
    <div className="set-label mono">
      <span>{label}</span>
      {action}
    </div>
    {children}
  </section>
)

const gbFree = (bytes: number): string => {
  const gb = bytes / 2 ** 30
  return gb >= 1 ? `${Math.round(gb)} GB FREE` : `${Math.round(bytes / 2 ** 20)} MB FREE`
}

const gb = (bytes: number): string => `${Math.max(0, Math.round(bytes / 2 ** 30))} GB`

/* ── Playback (spec §4.4): CURRENT MODE read-only context, per-wallpaper
   duration segmented control with in-place ◌→● commit, the single-loop
   note, and the interface-sounds master switch (wired in ticket 13). ─── */

const DURATIONS = [
  { min: 1, sec: 60 },
  { min: 5, sec: 300 },
  { min: 10, sec: 600 },
  { min: 30, sec: 1800 },
] as const

const MODE_LABEL: Record<string, string> = {
  single: "SINGLE — LOOP ONE",
  sequential: "SEQUENTIAL",
  shuffle: "SHUFFLE",
}

const PlaybackSec = ({ summary, onRefresh }: { summary: SystemSummary; onRefresh: () => void }) => {
  const player = summary.status.player
  const playMode = player?.play_mode ?? "single"
  const serverSec = player?.rotation_interval_sec ?? null
  const [pending, setPending] = useState<number | null>(null)
  const [committed, setCommitted] = useState<number | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [sounds, setSounds] = useState(getInterfaceSounds)

  // Once the server summary confirms the committed value, hand display back
  // to the server value so later external changes show up.
  useEffect(() => {
    if (committed !== null && serverSec === committed) setCommitted(null)
  }, [committed, serverSec])

  const shown = pending ?? committed ?? serverSec

  const commit = async (seconds: number) => {
    if (pending !== null || seconds === shown) return
    setPending(seconds)
    setCommitError(null)
    try {
      await api.setRotationInterval(seconds)
      setCommitted(seconds)
      onRefresh()
    } catch (e) {
      // Failure: nothing was committed locally — the control falls back to
      // the server's actual value (spec §4.4 回退语义).
      setCommitError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(null)
    }
  }

  const commitSounds = (on: boolean) => {
    setSounds(on)
    setInterfaceSounds(on)
  }

  const knownPreset = serverSec !== null && DURATIONS.some((d) => d.sec === serverSec)

  return (
    <>
      <Block label="PLAYBACK">
        <SpecRow name="Play mode" val={MODE_LABEL[playMode] ?? playMode.toUpperCase()} />
        <Note>SWITCH IN THE PLAYERBAR</Note>
      </Block>

      <Block label="DURATION">
        <div className="set-row">
          <span className="set-row-name">Duration per wallpaper</span>
          <span className="set-row-dots" aria-hidden="true" />
          <span className="set-seg mono" role="radiogroup" aria-label="Duration per wallpaper">
            {DURATIONS.map(({ min, sec }) => {
              const on = shown === sec && pending === null
              const busy = pending === sec
              return (
                <button
                  key={sec}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`${on ? "is-on" : ""}${busy ? " set-pending" : ""}`}
                  onClick={() => void commit(sec)}
                >
                  {busy ? "◌" : `${min}M`}
                </button>
              )
            })}
          </span>
        </div>
        {playMode === "single" && (
          <Note>CURRENTLY LOOPING ONE — DURATION TAKES EFFECT IN SEQUENTIAL OR SHUFFLE</Note>
        )}
        {!knownPreset && committed === null && serverSec !== null && (
          <Note>{`CURRENT — ${serverSec}S`}</Note>
        )}
        {commitError && <Note warn>{`COMMIT FAILED — ${commitError}`}</Note>}
      </Block>

      <Block label="INTERFACE">
        <div className="set-row">
          <span className="set-row-name">Interface sounds</span>
          <span className="set-row-dots" aria-hidden="true" />
          <span className="set-seg mono" role="radiogroup" aria-label="Interface sounds">
            {([["OFF", false], ["ON", true]] as const).map(([label, value]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={sounds === value}
                className={sounds === value ? "is-on" : ""}
                onClick={() => commitSounds(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <Note>UI SOUNDS ONLY — WALLPAPER AUDIO STAYS IN THE PLAYERBAR</Note>
      </Block>
    </>
  )
}

/* ── Storage (spec §4.4): current directory + DEFAULT tag, disk space row
   value + hairline capacity bar, and the glass focused flow for changing
   directories. A running migration locks the section down to a summary +
   the Activity handoff link; Activity owns progress phases and cancel. ── */

type SheetStep =
  | { kind: "browse"; path: string | null }
  | { kind: "validating"; target: string }
  | { kind: "impact"; target: string; validation: Extract<StorageTargetValidation, { ok: true }> }

const parentPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "") || "/"
  if (trimmed === "/") return "/"
  const slash = trimmed.lastIndexOf("/")
  return slash <= 0 ? "/" : trimmed.slice(0, slash)
}

/** Focused directory-change flow — the one place glass is allowed on this
 *  page (spec §2.4/§4.4). Locations → drill-in browse → automatic
 *  validation (writable / free space / existing content, ◌→✓ line by line)
 *  → impact confirm. The actual migration is handed to Activity. */
const DirectorySheet = ({
  currentRoot,
  defaultRoot,
  libraryTotal,
  onClose,
  onConfirm,
}: {
  currentRoot: string
  defaultRoot: string
  libraryTotal: number
  onClose: () => void
  onConfirm: (path: string) => Promise<string | null>
}) => {
  const [step, setStep] = useState<SheetStep>({ kind: "browse", path: null })
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [entries, setEntries] = useState<StorageDirectoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newDir, setNewDir] = useState("pi-wallpaper-engine")
  const [validation, setValidation] = useState<Extract<StorageTargetValidation, { ok: true }> | null>(null)
  const [checks, setChecks] = useState(0)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const stash = timers.current
    return () => stash.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirming) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [confirming, onClose])

  const showLocations = async () => {
    setLoading(true)
    setBrowseError(null)
    try {
      setLocations(await api.storageLocations())
      setStep({ kind: "browse", path: null })
      setEntries([])
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const showDirectory = async (path: string) => {
    setLoading(true)
    setBrowseError(null)
    setCreating(false)
    try {
      const listing = await api.storageDirectories(path)
      setStep({ kind: "browse", path: listing.path })
      setEntries(listing.entries)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void showLocations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createDirectory = async (path: string) => {
    if (!newDir.trim()) return
    setLoading(true)
    setBrowseError(null)
    try {
      const created = await api.createStorageDirectory({ parent: path, name: newDir.trim() })
      setCreating(false)
      setNewDir("pi-wallpaper-engine")
      await showDirectory(created.path)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  const select = (target: string) => {
    setStep({ kind: "validating", target })
    setValidation(null)
    setValidationError(null)
    setChecks(0)
    api
      .validateStorageTarget(target)
      .then((result) => {
        if (!result.ok) {
          setValidationError(result.error)
          return
        }
        setValidation(result)
        // Reveal the check lines one by one (◌→✓), then the impact layer.
        timers.current.push(setTimeout(() => setChecks(1), 250))
        timers.current.push(setTimeout(() => setChecks(2), 500))
        timers.current.push(setTimeout(() => setChecks(3), 750))
        timers.current.push(setTimeout(() => setStep({ kind: "impact", target, validation: result }), 1100))
      })
      .catch((e) => setValidationError(e instanceof Error ? e.message : String(e)))
  }

  const confirm = async (target: string) => {
    setConfirming(true)
    setConfirmError(null)
    const error = await onConfirm(target)
    setConfirming(false)
    if (error) {
      setConfirmError(error)
    } else {
      onClose()
    }
  }

  const contentLine = (v: Extract<StorageTargetValidation, { ok: true }>): string =>
    v.is_empty
      ? "EMPTY DIRECTORY"
      : v.has_source || v.has_optimized
        ? `EXISTING MEDIA — ${libraryTotal} ITEMS TO MIGRATE`
        : "NON-EMPTY DIRECTORY"

  const checkLabels = ["WRITABLE", "FREE SPACE", "EXISTING CONTENT"]
  const checkReadings = validation
    ? ["OK", gbFree(validation.free_bytes), contentLine(validation)]
    : null

  return (
    <div className="set-sheet">
      <div className="set-sheet-scrim" onClick={() => !confirming && onClose()} />
      <div
        className="set-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Change media directory"
      >
        <button
          type="button"
          className="set-sheet-close"
          aria-label="Close"
          autoFocus
          onClick={onClose}
          disabled={confirming}
        >
          ✕
        </button>
        <div className="set-sheet-body">
          <div className="set-sheet-title">Change media directory</div>

          {step.kind === "browse" && (
            <>
              <div className="set-label mono">
                <span>{step.path ?? "CHOOSE LOCATION"}</span>
                {step.path !== null && (
                  <button
                    type="button"
                    className="set-label-act mono"
                    onClick={() => {
                      const parent = parentPath(step.path as string)
                      if (locations.some((l) => l.path === step.path)) void showLocations()
                      else void showDirectory(parent)
                    }}
                    disabled={loading}
                  >
                    ↑ UP
                  </button>
                )}
              </div>
              {loading && <Note>READING…</Note>}
              {browseError && <Note warn>{browseError}</Note>}
              {!loading && step.path === null &&
                locations.map((loc) => (
                  <button
                    key={`${loc.id}:${loc.path}`}
                    type="button"
                    className="set-row set-row-btn set-row-cmd"
                    onClick={() => void showDirectory(loc.path)}
                  >
                    <span className="set-row-name">
                      {loc.label}
                      {loc.path === currentRoot && <span className="set-dim"> — CURRENT</span>}
                      {loc.path === defaultRoot && loc.path !== currentRoot && (
                        <span className="set-dim"> — DEFAULT</span>
                      )}
                    </span>
                    <span className="set-row-dots" aria-hidden="true" />
                    <span className="set-row-val mono">{loc.display_path}</span>
                    <span className="set-row-val mono set-row-arrow">→</span>
                  </button>
                ))}
              {!loading && step.path !== null && (
                <>
                  {entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="set-row set-row-btn set-row-cmd"
                      onClick={() => void showDirectory(entry.path)}
                    >
                      <span className="set-row-name">{entry.name}</span>
                      <span className="set-row-dots" aria-hidden="true" />
                      <span className="set-row-val mono set-row-arrow">→</span>
                    </button>
                  ))}
                  {entries.length === 0 && <Note>NO SUBDIRECTORIES</Note>}
                  {creating ? (
                    <div className="set-row">
                      <input
                        className="set-newdir mono"
                        value={newDir}
                        onChange={(e) => setNewDir(e.target.value)}
                        aria-label="New folder name"
                        disabled={loading}
                      />
                      <span className="set-row-dots" aria-hidden="true" />
                      <button
                        type="button"
                        className="set-label-act mono"
                        onClick={() => void createDirectory(step.path as string)}
                        disabled={loading || !newDir.trim()}
                      >
                        CREATE
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="set-row set-row-btn set-row-cmd"
                      onClick={() => setCreating(true)}
                      disabled={loading}
                    >
                      <span className="set-row-name">New folder</span>
                      <span className="set-row-dots" aria-hidden="true" />
                      <span className="set-row-val mono set-row-arrow">+</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="set-sheet-confirm mono"
                    onClick={() => select(step.path as string)}
                    disabled={loading}
                  >
                    USE THIS DIRECTORY
                  </button>
                </>
              )}
            </>
          )}

          {step.kind === "validating" && (
            <>
              <div className="set-label mono">{`VALIDATING — ${step.target}`}</div>
              {validationError ? (
                <>
                  <div className="set-check mono">
                    <span className="set-warn">✗</span>
                    {validationError}
                  </div>
                  <div className="set-sheet-actions">
                    <button
                      type="button"
                      className="set-chip mono"
                      onClick={() => void showLocations()}
                    >
                      BACK
                    </button>
                  </div>
                </>
              ) : (
                checkLabels.map((label, i) => (
                  <div key={label} className="set-check mono">
                    <span className={checks > i ? "set-check-ok" : "set-check-wait"}>
                      {checks > i ? "✓" : "◌"}
                    </span>
                    {checkReadings && checks > i ? `${label} — ${checkReadings[i]}` : label}
                  </div>
                ))
              )}
            </>
          )}

          {step.kind === "impact" && (
            <>
              <div className="set-label mono">CONFIRM IMPACT</div>
              <div className="set-impact">
                <div className="set-impact-line mono">
                  {libraryTotal > 0
                    ? `MIGRATE ${libraryTotal} ITEMS → ${step.target}`
                    : `SWITCH MEDIA DIRECTORY → ${step.target}`}
                </div>
                <div className="set-impact-line mono set-dim">
                  DOWNLOADS AND TRANSCODE PAUSE DURING MIGRATION — PROGRESS AND CANCEL IN ACTIVITY
                </div>
                {confirmError && (
                  <div className="set-impact-line mono set-warn">{confirmError}</div>
                )}
              </div>
              <div className="set-sheet-actions">
                <button
                  type="button"
                  className="set-sheet-confirm mono"
                  onClick={() => void confirm(step.target)}
                  disabled={confirming}
                >
                  {confirming
                    ? "STARTING…"
                    : libraryTotal > 0
                      ? "CONFIRM MIGRATION"
                      : "CONFIRM SWITCH"}
                </button>
                <button
                  type="button"
                  className="set-chip mono"
                  onClick={onClose}
                  disabled={confirming}
                >
                  CANCEL
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const StorageSec = ({
  summary,
  storage,
  mutateStorage,
  onRefresh,
}: {
  summary: SystemSummary
  storage: StorageStatus
  mutateStorage: (next: StorageStatus) => void
  onRefresh: () => void
}) => {
  const disk = summary.status.storage
  const libraryTotal = summary.status.library.total
  const [sheetOpen, setSheetOpen] = useState(false)
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)

  const migration = storage.migration
  const migratePct = migration
    ? Math.min(100, Math.round((migration.moved_bytes / Math.max(1, migration.total_bytes)) * 100))
    : 0

  const confirmTarget = async (path: string): Promise<string | null> => {
    try {
      const next = await api.switchStorageRoot(path)
      mutateStorage(next)
      setMigrationTarget(path)
      onRefresh()
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  const diskKnown = disk.free_bytes !== null && disk.used_percent !== null

  return (
    <>
      <Block label="MEDIA DIRECTORY">
        <SpecRow
          name="Media directory"
          val={
            <>
              {storage.data_root}
              {storage.using_default && <span className="set-default mono">DEFAULT</span>}
            </>
          }
        />
        {migration?.state !== "running" && (
          <SpecRow
            cmd
            name="Change directory"
            val="→"
            onClick={() => setSheetOpen(true)}
            disabled={!storage.available}
          />
        )}
      </Block>

      {migration && (
        <Block
          label={
            migration.state === "running"
              ? "MIGRATION — DIRECTORY LOCKED"
              : migration.state === "done"
                ? "MIGRATION — COMPLETE"
                : "MIGRATION — FAILED"
          }
        >
          {migration.state === "failed" && (
            <Note warn>{(migration.error ?? storage.last_error ?? "UNKNOWN ERROR").toUpperCase()}</Note>
          )}
          <SpecRow
            name={`→ ${migrationTarget ?? (migration.state === "done" ? storage.data_root : "…")}`}
            val={
              migration.state === "running" ? `${migratePct}%` : migration.state.toUpperCase()
            }
            warn={migration.state === "failed"}
          />
          {migration.state === "running" && <CapBar pct={migratePct} />}
          {migration.state === "done" && <Note>{`DIRECTORY NOW ${storage.data_root}`}</Note>}
          <SpecRow cmd name="View in Activity" val="→" href="/activity" />
        </Block>
      )}

      <Block label="DISK SPACE">
        {diskKnown ? (
          <>
            <SpecRow name="Disk space" val={gbFree(disk.free_bytes as number)} />
            <CapBar pct={disk.used_percent as number} />
            <Note>{`USED ${gb(disk.used_bytes ?? 0)} / ${gb(disk.total_bytes ?? 0)} — INCLUDES OTHER FILES ON THIS DISK`}</Note>
          </>
        ) : (
          <SpecRow
            name="Disk space"
            val={(disk.error ?? storage.last_error ?? "UNAVAILABLE").toUpperCase()}
            warn
          />
        )}
      </Block>

      {sheetOpen && (
        <DirectorySheet
          currentRoot={storage.data_root}
          defaultRoot={storage.default_root}
          libraryTotal={libraryTotal}
          onClose={() => setSheetOpen(false)}
          onConfirm={confirmTarget}
        />
      )}
    </>
  )
}

/* ── Access & Security (spec §4.4): protection status (disabled is a
   legitimate LAN-only state, not an error), passkey credentials with
   two-step named removal and the n/cap block head, and the current
   session's own sign-out command. ────────────────────────────────────── */

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

const AccessSec = () => {
  const { data: setupState } = useSWR("auth-setup-state", fetchSetupState)
  const enabled = setupState?.enabled ?? false
  const cap = setupState?.max_passkeys ?? 3
  const {
    data: passkeys,
    error: listError,
    mutate,
  } = useSWR(enabled ? "auth-passkeys" : null, listPasskeys)
  const [busy, setBusy] = useState<string | null>(null)
  const [arming, setArming] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    []
  )

  const count = passkeys?.length ?? 0
  const atLimit = count >= cap

  const arm = (id: string) => {
    setArming(id)
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setArming((a) => (a === id ? null : a)), 2200)
  }

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
    setArming(null)
    try {
      await deletePasskey(id)
      await mutate()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onSignOut = async () => {
    setBusy("signout")
    setActionError(null)
    try {
      await signOut()
      dispatchAuthChange()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <>
      <Block label="ACCESS PROTECTION">
        <SpecRow
          name="Access protection"
          val={enabled ? "ENABLED — PASSKEY" : "OFF — LAN ONLY"}
        />
        {!enabled && <Note>DISABLED IS A VALID LAN-ONLY STATE — ENABLE VIA CONFIG FOR PUBLIC EXPOSURE</Note>}
      </Block>

      {enabled && (
        <Block
          label={`PASSKEYS — ${count}/${cap}`}
          action={
            <button
              type="button"
              className="set-label-act mono"
              onClick={() => void onAdd()}
              disabled={busy !== null || atLimit}
            >
              {busy === "add" ? "WAITING…" : atLimit ? "LIMIT REACHED" : "+ ADD PASSKEY"}
            </button>
          }
        >
          {listError && <Note warn>{String(listError.message ?? listError)}</Note>}
          {!passkeys && !listError && <Note>LOADING…</Note>}
          {passkeys?.map((pk) => {
            const last = count <= 1
            const armed = arming === pk.id
            const name = pk.name || "Unnamed"
            return (
              <div key={pk.id} className="set-row">
                <span className="set-row-name">{name}</span>
                <span className="set-row-dots" aria-hidden="true" />
                <span className="set-row-val mono">{formatPasskeyDate(pk.createdAt)}</span>
                {last ? (
                  <span className="set-dim set-last">LAST PASSKEY CANNOT BE REMOVED</span>
                ) : (
                  <button
                    type="button"
                    className={`set-chip mono${armed ? " is-armed" : ""}`}
                    onClick={() => (armed ? void onDelete(pk.id) : arm(pk.id))}
                    disabled={busy !== null}
                  >
                    {busy === pk.id ? "REMOVING…" : armed ? `REMOVE ${name.toUpperCase()}?` : "REMOVE"}
                  </button>
                )}
              </div>
            )
          })}
        </Block>
      )}

      {enabled && (
        <Block label="SESSION">
          <SpecRow
            cmd
            name="Sign out"
            val={busy === "signout" ? "…" : "→"}
            onClick={() => void onSignOut()}
            disabled={busy !== null}
          />
        </Block>
      )}

      {actionError && <Note warn>{actionError}</Note>}
    </>
  )
}

/* ── System (spec §4.4): three health rows — Steam connection / display
   control / playback engine — OK/WARN readings, click to expand read-only
   parameters. Warned rows auto-expand with an amber actionable reason
   ahead of the technical parameters. ─────────────────────────────────── */

interface HealthItem {
  key: string
  name: string
  warn: boolean
  reason: string | null
  params: string[]
}

const buildHealthItems = (summary: SystemSummary): HealthItem[] => {
  const { config, status } = summary
  const signedIn = !!config.steam.username
  const display = status.display
  const displayWarn = !display.configured || display.error_kind !== null
  const mpvUp = !!status.player
  return [
    {
      key: "steam",
      name: "Steam connection",
      warn: !signedIn,
      reason: signedIn ? null : "NOT SIGNED IN — WORKSHOP DOWNLOADS UNAVAILABLE",
      params: [
        `USER ${config.steam.username || "—"}`,
        `WEB API KEY ${config.steam.web_api_key_masked}`,
        `STEAMCMD ${config.steam.steamcmd_path}`,
      ],
    },
    {
      key: "display",
      name: "Display control",
      warn: displayWarn,
      reason: !display.configured
        ? "ON/OFF COMMANDS NOT CONFIGURED — SLEEP FALLS BACK TO STOPPING PLAYBACK"
        : display.error_kind
          ? `LAST COMMAND FAILED — ${display.error_kind.toUpperCase()}`
          : null,
      params: [
        `SCREEN ${config.screen.width}×${config.screen.height} · ${config.screen.default_display_mode.toUpperCase()}`,
        `STATE ${display.state.toUpperCase()} · SOURCE ${display.source.toUpperCase()}`,
      ],
    },
    {
      key: "player",
      name: "Playback engine",
      warn: !mpvUp,
      reason: mpvUp ? null : "MPV PROCESS DOWN — PLAYBACK UNAVAILABLE",
      params: [
        `MPV ${config.mpv.binary_path}`,
        `HWDEC ${config.mpv.hwdec.toUpperCase()}`,
        `GPU-API ${config.mpv.gpu_api.toUpperCase()}`,
      ],
    },
  ]
}

const SystemSec = ({ summary }: { summary: SystemSummary }) => {
  const items = buildHealthItems(summary)
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(items.filter((h) => h.warn).map((h) => h.key))
  )
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Block label="HEALTH & DIAGNOSTICS">
      {items.map((h) => {
        const expanded = open.has(h.key)
        return (
          <div key={h.key} className="set-health">
            <SpecRow
              name={
                <>
                  <span className="set-caret" aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                  {h.name}
                </>
              }
              val={h.warn ? "WARN" : "OK"}
              warn={h.warn}
              onClick={() => toggle(h.key)}
            />
            {expanded && (
              <div className="set-params">
                {h.reason && <div className="set-reason mono">{h.reason}</div>}
                {h.params.map((p) => (
                  <div key={p} className="set-param mono">
                    {p}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </Block>
  )
}

/* ── Page ────────────────────────────────────────────────────────────── */

export const SettingsDesktop = ({ summary, onRefresh }: Props) => {
  const [, navigate] = useLocation()
  const search = useSearch()
  const sec = normalizeSec(new URLSearchParams(search).get("sec"))
  const { data: setupState } = useSWR("auth-setup-state", fetchSetupState)
  const { data: storage, mutate: mutateStorage } = useSWR("storage", api.getStorage, {
    refreshInterval: (data) => (data?.migration?.state === "running" ? 1000 : 5000),
    revalidateIfStale: true,
  })

  const goSec = (next: Sec) => {
    navigate(`/settings?sec=${next}`)
    window.scrollTo(0, 0)
  }

  const migration = storage?.migration ?? null
  const migratePct = migration
    ? Math.min(100, Math.round((migration.moved_bytes / Math.max(1, migration.total_bytes)) * 100))
    : 0
  const storageAttn = migration !== null && migration.state !== "done"
  const health = summary ? buildHealthItems(summary) : []
  const warnCount = health.filter((h) => h.warn).length

  const headCount = (s: Sec): string => {
    if (!summary) return ""
    switch (s) {
      case "playback":
        return `MODE — ${(summary.status.player?.play_mode ?? "single").toUpperCase()}`
      case "storage":
        if (migration?.state === "running") return `MIGRATING ${migratePct}%`
        return summary.status.storage.free_bytes !== null
          ? gbFree(summary.status.storage.free_bytes)
          : "—"
      case "access":
        return setupState?.enabled ? "PASSKEY" : "LAN ONLY"
      case "system":
        return warnCount > 0 ? `${health.length - warnCount} OK — ${warnCount} WARN` : `${health.length} OK`
    }
  }

  const railRow = (s: Sec, label: string, attn = false) => (
    <button
      key={s}
      type="button"
      className={`set-rc-row mono${sec === s ? " is-on" : ""}`}
      onClick={() => goSec(s)}
    >
      <span className="set-rc-row-name">{label}</span>
      <span className="set-rc-row-dots" aria-hidden="true" />
      <span className="set-rc-row-mark">{sec === s ? "●" : "○"}</span>
      {attn && <span className="set-rc-attn">!</span>}
    </button>
  )

  return (
    <div className="set">
      <RailControls>
        <div className="set-rc">
          <div className="set-rc-head mono">SECTIONS</div>
          {railRow("playback", "Playback")}
          {railRow("storage", "Storage", storageAttn)}
          {railRow("access", "Access & Security")}
        </div>
        <div className="set-rc set-rc-sys">{railRow("system", "System", warnCount > 0)}</div>
      </RailControls>

      <header className="set-head pt-enter">
        <h1 className="set-title">
          Settings<span className="set-title-slash"> / </span>
          {HEAD_TITLE[sec]}
        </h1>
        <span className="set-count mono">{headCount(sec)}</span>
      </header>

      {!summary ? (
        <StateBlock kind="loading" text="LOADING PI CONFIGURATION" />
      ) : (
        <div className="set-body">
          {sec === "playback" && <PlaybackSec summary={summary} onRefresh={onRefresh} />}
          {sec === "storage" &&
            (storage ? (
              <StorageSec
                summary={summary}
                storage={storage}
                mutateStorage={(next) => void mutateStorage(next, { revalidate: false })}
                onRefresh={onRefresh}
              />
            ) : (
              <StateBlock kind="loading" text="READING STORAGE" />
            ))}
          {sec === "access" && <AccessSec />}
          {sec === "system" && <SystemSec summary={summary} />}
        </div>
      )}
    </div>
  )
}
