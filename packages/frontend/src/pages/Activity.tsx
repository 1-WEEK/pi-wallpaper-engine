import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isAdultContent } from "@pwe/shared"
import useSWR from "swr"
import useSWRInfinite from "swr/infinite"
import { api, type ActivityTask, type MigrationProgress, type PaginatedTasks } from "../api.js"
import { formatBytes } from "../format.js"
import { isTaskFailed, isTaskFinished, taskStageLabel } from "../taskDisplay.js"
import { useLayout, MobileSheet } from "../components/mobile/index.js"
import { RailControls } from "../components/RailShell.js"
import { RailRow } from "../components/RailRow.js"
import { StateBlock } from "../components/StateBlock.js"
import { useReducedMotion } from "../reducedMotion.js"
import { sounds } from "../sound.js"

const REFRESH_MS = 1000
const PAGE_SIZE = 50

/** Settle beat (spec §4.3, duration registered in the §5 exception table):
 *  a task that reaches a terminal stage holds its row in ACTIVE for 1.4s —
 *  COMPLETE pill flashes inverse twice (700ms × 2) — then drops to FINISHED. */
const SETTLE_MS = 1400

const MIGRATION_ROW_ID = "storage-migration"

const formatElapsed = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
  }
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
}

const isAdultTask = (task: ActivityTask): boolean =>
  isAdultContent({
    title: task.title,
    contentRating: task.content_rating,
    ratingSex: task.rating_sex,
    adultHint: task.adult_hint,
  })

/* ── Desktop (implementation ticket 09, spec §4.3) ─────────────────
   ACTIVE / FINISHED ledger, header `n ACTIVE — m FINISHED — k FAILED`.
   Row = 64px thumb + title + TYPE border pill + STAGE pill (300ms flip on
   stage change) + mono readout line + hairline progress (determinate via
   transform: scaleX, indeterminate as a scan segment). Terminal tasks play
   the settle beat before dropping into FINISHED; failures expand a red mono
   ERR line. Storage migrations surface as a synthesized row with the
   COPY → VERIFY → SWITCH → CLEANUP phase readout. */

type QueueRow =
  | {
      kind: "task"
      id: string
      terminal: boolean
      failed: boolean
      task: ActivityTask
    }
  | {
      kind: "migration"
      id: string
      terminal: boolean
      failed: boolean
      migration: MigrationProgress
    }

const ActivityDesktop = () => {
  const [showAdult, setShowAdult] = useState(false)
  const reducedMotion = useReducedMotion()

  const getDlKey = (pageIndex: number, previousPageData: PaginatedTasks | null) => {
    if (previousPageData && !previousPageData.items.length) return null
    return ["tasks", pageIndex * PAGE_SIZE, PAGE_SIZE] as const
  }
  const fetcher = ([_, offset, limit]: readonly [string, number, number]) =>
    api.tasks({ offset, limit })

  const {
    data: dData,
    error: dError,
    mutate: dMutate,
    size: dSize,
    setSize: setDSize,
  } = useSWRInfinite(getDlKey, fetcher, {
    revalidateIfStale: true,
  })

  // Only the active set polls continuously; history pages are fetched on
  // demand so finished rows never shift under the user.
  const {
    data: activePageData,
    error: activeError,
    mutate: activeMutate,
  } = useSWR("active-tasks", () => api.tasks({ active: true, limit: PAGE_SIZE }), {
    refreshInterval: REFRESH_MS,
  })

  // Storage migrations don't appear in the task feed — poll the storage
  // status (shared SWR key with Settings) and synthesize a queue row. The
  // interval function must be referentially stable: SWR's polling effect
  // re-arms on its identity, and this page re-renders every second for the
  // elapsed tick — an inline function would never let the timer fire.
  const storageRefreshInterval = useCallback(
    (data: { migration?: { state: string } | null } | undefined) =>
      data?.migration?.state === "running" ? REFRESH_MS : 5000,
    []
  )
  const { data: storage, mutate: storageMutate } = useSWR("storage", api.getStorage, {
    refreshInterval: storageRefreshInterval,
  })
  const migration = storage?.migration ?? null

  // When a task leaves the active set it just reached a terminal stage (or
  // was dismissed) — revalidate the static history pages once to pick it up.
  const prevActiveIds = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const ids = new Set((activePageData?.items ?? []).map((t) => t.task_id))
    const prev = prevActiveIds.current
    prevActiveIds.current = ids
    if ([...prev].some((id) => !ids.has(id))) dMutate()
  }, [activePageData, dMutate])

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const h = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(h)
  }, [])

  // iOS Safari aborts in-flight fetches when the page is backgrounded, and
  // SWR's resume-time focus revalidation can dedupe into that dying request,
  // leaving the history hook stuck on an AbortError. mutate() bypasses
  // deduping, so force a clean revalidation when we return to the foreground.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      dMutate()
      activeMutate()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [dMutate, activeMutate])

  const allTasks = useMemo(() => {
    const history = dData ? dData.flatMap((page) => page.items) : []
    const active = activePageData?.items || []
    const map = new Map<string, ActivityTask>()
    for (const t of history) map.set(t.task_id, t)
    // The active overlay wins: it carries the freshest state for its ids.
    for (const t of active) map.set(t.task_id, t)
    return Array.from(map.values()).sort((a, b) => b.started_at - a.started_at)
  }, [dData, activePageData])

  const hasMoreDl = dData && dData[dData.length - 1]?.items.length === PAGE_SIZE

  const visibleTasks = useMemo(
    () => (showAdult ? allTasks : allTasks.filter((t) => !isAdultTask(t))),
    [allTasks, showAdult]
  )

  const rows = useMemo<QueueRow[]>(() => {
    const list: QueueRow[] = visibleTasks.map((task) => ({
      kind: "task",
      id: task.task_id,
      terminal: isTaskFinished(task),
      failed: isTaskFailed(task),
      task,
    }))
    if (migration) {
      list.unshift({
        kind: "migration",
        id: MIGRATION_ROW_ID,
        terminal: migration.state !== "running",
        failed: migration.state === "failed",
        migration,
      })
    }
    return list
  }, [visibleTasks, migration])

  /* Settle beat: when a row flips active → terminal, pin it in ACTIVE for
     SETTLE_MS (the COMPLETE pill's inverse flash runs on the .act-settle
     class), then release it into FINISHED. Timers live outside the effect
     lifecycle so the 1s polling re-render never cancels a beat mid-flight;
     reduced motion skips the hold entirely — the row moves on the next poll
     and no information is lost. */
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set())
  const prevTerminal = useRef(new Map<string, boolean>())
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    for (const row of rows) {
      const prev = prevTerminal.current.get(row.id)
      prevTerminal.current.set(row.id, row.terminal)
      if (!row.terminal || prev !== false || reducedMotion) continue
      if (settleTimers.current.has(row.id)) continue
      settleTimers.current.set(
        row.id,
        setTimeout(() => {
          settleTimers.current.delete(row.id)
          setSettling((s) => {
            const next = new Set(s)
            next.delete(row.id)
            return next
          })
        }, SETTLE_MS)
      )
      setSettling((s) => new Set(s).add(row.id))
    }
  }, [rows, reducedMotion])
  useEffect(
    () => () => {
      for (const timer of settleTimers.current.values()) clearTimeout(timer)
    },
    []
  )

  // Interface sound (ticket 13, spec §6): a row crossing running → terminal
  // is the state-receipt trigger — complete lands the transition family on
  // the settle beat, failed lands warn on the error-line expand. Rows that
  // arrive already terminal (history pages) never fire, and the engine
  // itself drops these while hidden / under reduced motion (transition only).
  const prevRowState = useRef(new Map<string, "running" | "done" | "failed">())
  useEffect(() => {
    const prev = prevRowState.current
    for (const row of rows) {
      const state = !row.terminal ? "running" : row.failed ? "failed" : "done"
      const was = prev.get(row.id)
      prev.set(row.id, state)
      if (was !== "running") continue
      if (state === "done") sounds.trigger("done")
      else if (state === "failed") sounds.trigger("fail")
    }
  }, [rows])

  const activeRows = rows.filter((r) => !r.terminal || settling.has(r.id))
  const finishedRows = rows.filter((r) => r.terminal && !settling.has(r.id))

  // The header's ACTIVE count prefers the server's unpaginated total (the
  // active page is capped at PAGE_SIZE); settling rows already left the
  // server set, and the migration row lives outside the task feed — both
  // are added back so the count matches what the section shows.
  const activeCount =
    (activePageData?.total ?? activeRows.filter((r) => r.kind === "task" && !r.terminal).length) +
    activeRows.filter((r) => r.kind === "migration" || r.terminal).length
  const finishedCount = finishedRows.length
  const failedCount = rows.filter((r) => r.failed).length

  const dismissTask = async (id: string) => {
    await api.dismissTask(id)
    dMutate()
    activeMutate()
  }

  const cancelTask = async (id: string) => {
    await api.cancelDownload(id).catch(() => {})
    dMutate()
    activeMutate()
  }

  const retryTask = async (task: ActivityTask) => {
    if (task.task_type === "download") {
      await api.download(task.workshop_id).catch(() => {})
    } else {
      await api.libraryTranscode(task.workshop_id).catch(() => {})
    }
    dMutate()
    activeMutate()
  }

  const dismissAll = async (stage: "complete" | "error") => {
    await api.dismissAllTasks(stage).catch(() => {})
    dMutate()
    activeMutate()
  }

  const retryAllTranscodes = async () => {
    await api.libraryTranscodeRetryAll().catch(() => {})
    dMutate()
    activeMutate()
  }

  // Both cancel and dismiss of the migration row go through the one storage
  // cancel endpoint: while running it interrupts the job, and for a terminal
  // record it clears the status (the only dismissal the backend exposes).
  const cancelMigration = async () => {
    const next = await api.cancelMigration().catch(() => null)
    if (next) storageMutate(next, { revalidate: false })
    else storageMutate()
  }

  const combinedError = dError || activeError
  const hasAnyData = dData !== undefined || activePageData !== undefined

  return (
    <div className="act">
      <RailControls>
        <div>
          <div className="lib-rc-title mono">HOUSEKEEPING</div>
          <RailRow label="Clear completed" mark="→" onClick={() => void dismissAll("complete")} />
          <RailRow label="Clear failed" mark="→" onClick={() => void dismissAll("error")} />
          <RailRow
            label="Retry failed transcodes"
            mark="→"
            onClick={() => void retryAllTranscodes()}
          />
        </div>
        {/* Discreet 18+ entry (spec §4.1): two faint dots at rest, no
            counts or labels anywhere else. */}
        <div className="lib-rc-content">
          <button
            type="button"
            className={`mono${showAdult ? " is-on" : ""}`}
            aria-label="Toggle adult content"
            aria-pressed={showAdult}
            onClick={() => setShowAdult((s) => !s)}
          >
            {showAdult ? "● 18+" : "••"}
          </button>
        </div>
      </RailControls>

      <header className="act-head pt-enter">
        <h1 className="act-title">
          Activity<span className="act-title-slash"> / </span>Queue
        </h1>
        <span className="act-count mono">
          {activeCount} ACTIVE — {finishedCount} FINISHED — {failedCount} FAILED
        </span>
      </header>

      {!hasAnyData && !combinedError && <StateBlock kind="loading" text="FETCHING QUEUE…" />}
      {/* Page-level error only when nothing could load at all (§3.3); a
          transient poll failure keeps the cached list on screen. */}
      {combinedError != null && !hasAnyData && (
        <StateBlock
          kind="error"
          text={`ERR — ${(combinedError as Error).message}`}
          onRetry={() => {
            dMutate()
            activeMutate()
          }}
        />
      )}

      {hasAnyData && (
        <>
          <section aria-label="Active tasks">
            <div className="act-sec-head mono">
              <span>ACTIVE</span>
              <span>{activeRows.length}</span>
            </div>
            <ul className="act-list">
              {activeRows.map((row) =>
                row.kind === "task" ? (
                  <TaskRow
                    key={row.id}
                    task={row.task}
                    settling={settling.has(row.id)}
                    nowTick={nowTick}
                    onDismiss={dismissTask}
                    onCancel={cancelTask}
                    onRetry={retryTask}
                  />
                ) : (
                  <MigrationRow
                    key={row.id}
                    migration={row.migration}
                    settling={settling.has(row.id)}
                    onCancel={cancelMigration}
                    onDismiss={cancelMigration}
                  />
                )
              )}
            </ul>
            {activeRows.length === 0 && (
              <StateBlock kind="empty" text="QUEUE IDLE — NOTHING IN FLIGHT" />
            )}
          </section>

          <section className="act-sec-finished" aria-label="Finished tasks">
            <div className="act-sec-head mono">
              <span>FINISHED</span>
              <span>{finishedRows.length}</span>
            </div>
            <ul className="act-list">
              {finishedRows.map((row) =>
                row.kind === "task" ? (
                  <TaskRow
                    key={row.id}
                    task={row.task}
                    settling={false}
                    nowTick={nowTick}
                    onDismiss={dismissTask}
                    onCancel={cancelTask}
                    onRetry={retryTask}
                  />
                ) : (
                  <MigrationRow
                    key={row.id}
                    migration={row.migration}
                    settling={false}
                    onCancel={cancelMigration}
                    onDismiss={cancelMigration}
                  />
                )
              )}
            </ul>
            {finishedRows.length === 0 && <StateBlock kind="empty" text="NO HISTORY" />}
            {hasMoreDl && (
              <button
                type="button"
                className="act-more mono"
                onClick={() => setDSize(dSize + 1)}
              >
                LOAD MORE →
              </button>
            )}
          </section>
        </>
      )}
    </div>
  )
}

interface TaskRowProps {
  task: ActivityTask
  settling: boolean
  nowTick: number
  onDismiss: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (task: ActivityTask) => void
}

const TaskRow = ({ task, settling, nowTick, onDismiss, onCancel, onRetry }: TaskRowProps) => {
  const failed = isTaskFailed(task)
  const finished = isTaskFinished(task)

  const elapsed = formatElapsed(((task.finished_at ?? nowTick) - task.started_at) / 1000)
  const determinate = task.percent !== null && task.percent !== undefined
  const percentClamped = determinate && task.percent !== null
    ? Math.max(0, Math.min(100, task.percent))
    : 0

  const stageCls = failed
    ? "act-stage mono act-stage-err"
    : finished
      ? "act-stage mono act-stage-done"
      : "act-stage mono"

  return (
    <li className={`act-row pt-enter${settling ? " act-settle" : ""}${failed ? " act-row-err" : ""}`}>
      <span className="act-thumb">
        {task.preview_url ? <img src={task.preview_url} alt="" loading="lazy" /> : null}
      </span>
      <span className="act-main">
        <span className="act-line1">
          <span className="act-row-title">{task.title}</span>
          <span className="act-type mono">
            {task.task_type === "transcode" ? "TRANSCODE" : "DOWNLOAD"}
          </span>
          {isAdultTask(task) && <span className="act-type mono">18+</span>}
          {/* The pill remounts on every stage change — the CSS entrance
              (300ms flip-in) marks the state machine advancing. */}
          <span key={task.stage} className={stageCls}>
            {taskStageLabel(task).toUpperCase()}
          </span>
        </span>
        <span className="act-line2 mono">
          {`ID ${task.workshop_id}`}
          {task.bytes_total !== null && task.bytes_total !== undefined && task.bytes_total > 0
            ? ` · ${formatBytes(task.bytes_done ?? 0)} / ${formatBytes(task.bytes_total)}`
            : ""}
          {` · ${elapsed}`}
          {determinate ? ` · ${Math.round(percentClamped)}%` : ""}
        </span>
        {failed && task.message && (
          <span className="act-errline mono">ERR — {task.message}</span>
        )}
      </span>
      {(!finished || settling) && (
        <span
          className={`act-bar${determinate ? "" : " act-bar-indet"}`}
          role="progressbar"
          aria-valuenow={determinate ? percentClamped : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {determinate && (
            <span
              className="act-bar-fill"
              style={{ transform: `scaleX(${percentClamped / 100})` }}
            />
          )}
        </span>
      )}
      <span className="act-actions">
        {/* CANCEL is download/migration only — transcode has no cancel,
            matching the production backend. */}
        {!finished && !settling && task.task_type === "download" && (
          <button type="button" className="act-act mono" onClick={() => onCancel(task.workshop_id)}>
            CANCEL
          </button>
        )}
        {finished && failed && (
          <button type="button" className="act-act mono" onClick={() => onRetry(task)}>
            RETRY
          </button>
        )}
        {finished && (
          <button type="button" className="act-act mono" onClick={() => onDismiss(task.task_id)}>
            DISMISS
          </button>
        )}
      </span>
    </li>
  )
}

const MIGRATION_PHASES = ["COPY", "VERIFY", "SWITCH", "CLEANUP"] as const

/** The backend reports byte progress + state only, so the current phase is
 *  derived: COPY while bytes are still moving, VERIFY once every byte has
 *  landed (verify/switch/cleanup run without further progress updates, and
 *  the last two are uninterruptible and sub-second — they only ever surface
 *  as reached at DONE). */
const migrationPhaseIndex = (m: MigrationProgress): number =>
  m.total_bytes > 0 && m.moved_bytes >= m.total_bytes ? 1 : 0

const MigrationRow = ({
  migration,
  settling,
  onCancel,
  onDismiss,
}: {
  migration: MigrationProgress
  settling: boolean
  onCancel: () => void
  onDismiss: () => void
}) => {
  const terminal = migration.state !== "running"
  const failed = migration.state === "failed"
  const current = migrationPhaseIndex(migration)
  const pct =
    migration.total_bytes > 0
      ? Math.min(100, (migration.moved_bytes / migration.total_bytes) * 100)
      : null

  const stageCls = failed
    ? "act-stage mono act-stage-err"
    : terminal
      ? "act-stage mono act-stage-done"
      : "act-stage mono"

  return (
    <li className={`act-row pt-enter${settling ? " act-settle" : ""}${failed ? " act-row-err" : ""}`}>
      <span className="act-thumb">
        <span className="act-thumb-swap mono" aria-hidden="true">
          ⇄
        </span>
      </span>
      <span className="act-main">
        <span className="act-line1">
          <span className="act-row-title">Storage migration</span>
          <span className="act-type mono">MIGRATION</span>
          <span key={migration.state} className={stageCls}>
            {migration.state === "running" ? "RUNNING" : failed ? "FAILED" : "COMPLETE"}
          </span>
        </span>
        <span className="act-line2 mono">
          {formatBytes(migration.moved_bytes)} / {formatBytes(migration.total_bytes)}
          {pct !== null ? ` · ${Math.round(pct)}%` : ""}
        </span>
        {!terminal && (
          <span className="act-phases mono" aria-label="Migration phases">
            {MIGRATION_PHASES.map((phase, i) => (
              <span key={phase} className={i < current ? "is-done" : i === current ? "is-now" : ""}>
                {i < current ? "●" : i === current ? "◉" : "○"} {phase}
              </span>
            ))}
          </span>
        )}
        {failed && (
          <span className="act-errline mono">ERR — {migration.error ?? "Migration failed."}</span>
        )}
      </span>
      {(!terminal || settling) && (
        <span
          className={`act-bar${pct === null ? " act-bar-indet" : ""}`}
          role="progressbar"
          aria-valuenow={pct !== null ? Math.round(pct) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {pct !== null && (
            <span className="act-bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          )}
        </span>
      )}
      <span className="act-actions">
        {!terminal && !settling && (
          <button type="button" className="act-act mono" onClick={onCancel}>
            CANCEL
          </button>
        )}
        {terminal && (
          <button type="button" className="act-act mono" onClick={onDismiss}>
            DISMISS
          </button>
        )}
      </span>
    </li>
  )
}

/* ── Mobile (spec §9): the same `.act-*` ledger at a tighter measure —
     rows, settle beat and stage pills are identical to desktop; the rail's
     HOUSEKEEPING commands and the discreet 18+ entry move into a Sheet
     behind one header command. ─────────────────────────────────────────── */

const useActivityQueue = () => {
  const getDlKey = (pageIndex: number, previousPageData: PaginatedTasks | null) => {
    if (previousPageData && !previousPageData.items.length) return null
    return ["tasks", pageIndex * PAGE_SIZE, PAGE_SIZE] as const
  }
  const fetcher = ([_, offset, limit]: readonly [string, number, number]) => api.tasks({ offset, limit })

  const { data: dData, error: dError, mutate: dMutate, size: dSize, setSize: setDSize } = useSWRInfinite(getDlKey, fetcher, {
    revalidateIfStale: true,
  })

  // Only the active set polls continuously; history pages are fetched on
  // demand so finished rows never shift under the user.
  const { data: activePageData, error: activeError, mutate: activeMutate } = useSWR(
    "active-tasks",
    () => api.tasks({ active: true, limit: PAGE_SIZE }),
    { refreshInterval: REFRESH_MS }
  )

  // When a task leaves the active set it just reached a terminal stage (or
  // was dismissed) — revalidate the static history pages once to pick it up.
  const prevActiveIds = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const ids = new Set((activePageData?.items ?? []).map((t) => t.task_id))
    const prev = prevActiveIds.current
    prevActiveIds.current = ids
    if ([...prev].some((id) => !ids.has(id))) dMutate()
  }, [activePageData, dMutate])

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const h = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(h)
  }, [])

  // iOS Safari aborts in-flight fetches when the page is backgrounded, and
  // SWR's resume-time focus revalidation can dedupe into that dying request,
  // leaving the history hook stuck on an AbortError. mutate() bypasses
  // deduping, so force a clean revalidation when we return to the foreground.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      dMutate()
      activeMutate()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [dMutate, activeMutate])

  const allTasks = useMemo(() => {
    const history = dData ? dData.flatMap(page => page.items) : []
    const active = activePageData?.items || []
    const map = new Map<string, ActivityTask>()
    for (const t of history) map.set(t.task_id, t)
    // The active overlay wins: it carries the freshest state for its ids.
    for (const t of active) map.set(t.task_id, t)
    return Array.from(map.values()).sort((a, b) => b.started_at - a.started_at)
  }, [dData, activePageData])

  const hasMoreDl = !!(dData && dData[dData.length - 1]?.items.length === PAGE_SIZE)

  const dismissTask = async (id: string) => {
    await api.dismissTask(id)
    dMutate()
    activeMutate()
  }

  const cancelTask = async (id: string) => {
    await api.cancelDownload(id).catch(() => {})
    dMutate()
    activeMutate()
  }

  const retryTask = async (task: ActivityTask) => {
    if (task.task_type === "download") {
      await api.download(task.workshop_id).catch(() => {})
    } else {
      await api.libraryTranscode(task.workshop_id).catch(() => {})
    }
    dMutate()
    activeMutate()
  }

  const combinedError = dError || activeError
  const hasAnyData = dData !== undefined || activePageData !== undefined

  return {
    allTasks,
    activeTotal: activePageData?.total,
    nowTick,
    hasMoreDl,
    loadMore: () => setDSize(dSize + 1),
    combinedError,
    hasAnyData,
    dismissTask,
    cancelTask,
    retryTask,
    revalidate: () => {
      dMutate()
      activeMutate()
    },
  }
}

const ActivityMobile = () => {
  const [showAdult, setShowAdult] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const {
    allTasks,
    activeTotal,
    nowTick,
    hasMoreDl,
    loadMore,
    combinedError,
    hasAnyData,
    dismissTask,
    cancelTask,
    retryTask,
    revalidate,
  } = useActivityQueue()

  const adultCount = useMemo(() => allTasks.filter(isAdultTask).length, [allTasks])

  const visibleTasks = useMemo(
    () => (showAdult ? allTasks : allTasks.filter((t) => !isAdultTask(t))),
    [allTasks, showAdult]
  )

  const activeTasks = visibleTasks.filter((t) => !isTaskFinished(t))
  const finishedTasks = visibleTasks.filter((t) => isTaskFinished(t))
  const failedCount = visibleTasks.filter(isTaskFailed).length
  const activeCount = activeTotal ?? activeTasks.length

  const dismissAll = async (stage: "complete" | "error") => {
    await api.dismissAllTasks(stage).catch(() => {})
    revalidate()
  }

  const retryAllTranscodes = async () => {
    await api.libraryTranscodeRetryAll().catch(() => {})
    revalidate()
  }

  return (
    <div className="act">
      <header className="act-head pt-enter">
        <h1 className="act-title">
          Activity<span className="act-title-slash"> / </span>Queue
        </h1>
        <button type="button" className="mp-cmd mono" onClick={() => setQueueOpen(true)}>
          QUEUE…
        </button>
      </header>

      {!hasAnyData && !combinedError && <StateBlock kind="loading" text="FETCHING QUEUE…" />}
      {/* A transient poll failure keeps the cached list on screen — the
          page-level error only replaces it when nothing could load at all. */}
      {combinedError != null && !hasAnyData && (
        <StateBlock
          kind="error"
          text={`ERR — ${(combinedError as Error).message}`}
          onRetry={revalidate}
        />
      )}

      {hasAnyData && (
        <>
          <section aria-label="Active tasks">
            <div className="act-sec-head mono">
              <span>ACTIVE</span>
              <span>{activeTasks.length}</span>
            </div>
            <ul className="act-list">
              {activeTasks.map((t) => (
                <TaskRow
                  key={t.task_id}
                  task={t}
                  settling={false}
                  nowTick={nowTick}
                  onDismiss={dismissTask}
                  onCancel={cancelTask}
                  onRetry={retryTask}
                />
              ))}
            </ul>
            {activeTasks.length === 0 && (
              <StateBlock kind="empty" text="QUEUE IDLE — NOTHING IN FLIGHT" />
            )}
          </section>

          <section className="act-sec-finished" aria-label="Finished tasks">
            <div className="act-sec-head mono">
              <span>FINISHED</span>
              <span>{finishedTasks.length}</span>
            </div>
            <ul className="act-list">
              {finishedTasks.map((t) => (
                <TaskRow
                  key={t.task_id}
                  task={t}
                  settling={false}
                  nowTick={nowTick}
                  onDismiss={dismissTask}
                  onCancel={cancelTask}
                  onRetry={retryTask}
                />
              ))}
            </ul>
            {finishedTasks.length === 0 && <StateBlock kind="empty" text="NO HISTORY" />}
            {hasMoreDl && (
              <button type="button" className="act-more mono" onClick={loadMore}>
                LOAD MORE →
              </button>
            )}
          </section>
        </>
      )}

      {/* Housekeeping + the discreet 18+ entry (the desktop rail's
          HOUSEKEEPING block, spec §4.1/§9). */}
      <MobileSheet open={queueOpen} onClose={() => setQueueOpen(false)} title="Queue" height="auto">
        <div className="actm-sheet-body">
          <button
            type="button"
            className="mp-cmd mono"
            onClick={() => void dismissAll("complete")}
          >
            CLEAR COMPLETED →
          </button>
          <button
            type="button"
            className="mp-cmd mono"
            onClick={() => void dismissAll("error")}
          >
            CLEAR FAILED →
          </button>
          <button
            type="button"
            className="mp-cmd mono"
            onClick={() => void retryAllTranscodes()}
          >
            RETRY FAILED TRANSCODES →
          </button>
          <div className="actm-privacy">
            <div className="actm-privacy-title mono">Safe queue</div>
            <p className="actm-privacy-note">
              {adultCount > 0
                ? showAdult
                  ? "All queued and finished tasks are visible in this session."
                  : `${adultCount} mature task${adultCount === 1 ? "" : "s"} hidden in this session.`
                : "No mature-marked tasks found."}
            </p>
            <div className="mpm-seg">
              <button
                type="button"
                className={!showAdult ? "is-on" : ""}
                aria-pressed={!showAdult}
                onClick={() => setShowAdult(false)}
              >
                Safe
              </button>
              <button
                type="button"
                className={showAdult ? "is-on" : ""}
                aria-pressed={showAdult}
                onClick={() => setShowAdult(true)}
              >
                All
              </button>
            </div>
          </div>
        </div>
      </MobileSheet>
    </div>
  )
}

export const Activity = () => {
  const { mobile } = useLayout()
  return mobile ? <ActivityMobile /> : <ActivityDesktop />
}
