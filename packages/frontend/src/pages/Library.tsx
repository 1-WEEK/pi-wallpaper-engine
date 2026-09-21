import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { flushSync } from "react-dom"
import { isAdultContent, type LibraryItem } from "@pwe/shared"
import useSWR from "swr"
import { api } from "../api.js"
import { formatBytes, spaceSavedPercent } from "../format.js"
import { appIcons } from "../icons.js"
import { useLayout } from "../components/mobile/index.js"
import { VideoPreview } from "../components/VideoPreview.js"
import { RailControls } from "../components/RailShell.js"
import { GridOverlay } from "../components/GridOverlay.js"
import { FocusRing, FOCUS_CONFIRM_MS } from "../components/FocusRing.js"
import { LedgerList, LedgerRow } from "../components/LedgerList.js"
import { StateBlock } from "../components/StateBlock.js"
import { prefersReducedMotion } from "../reducedMotion.js"
import { canViewTransition, withViewTransition } from "../viewTransition.js"
import { flyGhost } from "../ghost.js"
import { duration } from "../motionTokens.js"
import { useColumnsPerRow } from "../useColumnsPerRow.js"

interface Props {
  nowPlayingId: string | null
  onSystemRefresh: () => void
}

const MIN_CARD_WIDTH = 248
const GRID_GAP = 16

/* ── Shared row semantics ────────────────────────────────────────── */

const playableResolution = (row: LibraryItem): string =>
  row.transcoded_resolution ?? row.source_resolution

const playableCodec = (row: LibraryItem): string => row.transcoded_codec ?? row.source_codec

const playableSize = (row: LibraryItem): number => row.transcoded_size ?? row.source_size

/** Caption meta (spec §4.2): transcoded readout preferred + ↓n% saved. */
const playableMeta = (row: LibraryItem): string => {
  const base = `${playableResolution(row)} · ${playableCodec(row).toUpperCase()} · ${formatBytes(playableSize(row))}`
  const saved = spaceSavedPercent(row)
  return saved !== null && saved > 0 ? `${base} ↓${saved}%` : base
}

/** TX pill label (spec §4.2: running/pending/failed, non-default states
 *  only) — null when the row is in a default state (completed/skipped). */
const txLabel = (row: LibraryItem): string | null => {
  switch (row.transcode_status) {
    case "running":
      return `TX ${Math.round(row.transcode_progress)}%`
    case "uploading":
      return "TX UPLOADING"
    case "pending":
    case "claimed":
      return "TX QUEUED"
    case "failed":
      return "TX FAILED"
    default:
      return null
  }
}

const TxPill = ({ row, inline = false }: { row: LibraryItem; inline?: boolean }) => {
  const label = txLabel(row)
  if (!label) return null
  const err = row.transcode_status === "failed"
  return (
    <span className={`lib-tx${inline ? " lib-tx-inline" : ""}${err ? " lib-tx-err" : ""} mono`}>
      {label}
    </span>
  )
}

const isAdultRow = (row: LibraryItem): boolean =>
  isAdultContent({
    title: row.title,
    contentRating: row.content_rating,
    ratingSex: row.rating_sex,
  })

const canRetranscode = (status: LibraryItem["transcode_status"]): boolean =>
  status === "failed" || status === "skipped"

const canPreview = (row: LibraryItem): boolean => row.transcode_status === "completed"

/* ── Shared backend intents (identical behavior on desktop + mobile) ── */

interface Intents {
  play: (id: string) => void
  remove: (id: string) => void
  transcode: (id: string) => void
}

const useLibraryRows = () =>
  useSWR("library-list", api.libraryList, {
    refreshInterval: 5000,
    revalidateIfStale: true,
  })

const useIntents = (
  mutate: () => Promise<unknown>,
  onSystemRefresh: () => void,
  setError: (e: string | null) => void,
  setNotice: (n: string | null) => void
): Intents => ({
  play: (id) =>
    api
      .play(id)
      .then(() => {
        setError(null)
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message)),
  // Two-step confirm lives in the UI (DELETE → SURE?); this fires the delete.
  remove: (id) =>
    api
      .libraryDelete(id)
      .then(async () => {
        setError(null)
        await mutate()
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message)),
  transcode: (id) =>
    api
      .libraryTranscode(id)
      .then(async (res) => {
        setError(null)
        setNotice(res.transcode_status === "skipped" ? `Not queued — ${res.reason}` : null)
        await mutate()
      })
      .catch((e: Error) => setError(e.message)),
})

/* ── Hover action cluster (spec §4.2): PLAY inverse primary / PREVIEW
     (transcoded only) / DELETE two-step SURE?. Shared by grid cards and
     ledger rows; clicks never reach the row's select/open handlers. ── */

const HoverActions = ({
  row,
  intents,
  onPreview,
}: {
  row: LibraryItem
  intents: Intents
  onPreview: (row: LibraryItem) => void
}) => {
  const [confirming, setConfirming] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return (
    <span
      className="lib-actions"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="lib-act lib-act-primary mono"
        onClick={() => intents.play(row.workshop_id)}
      >
        PLAY
      </button>
      {canPreview(row) && (
        <button
          type="button"
          className="lib-act mono"
          onClick={() => onPreview(row)}
          aria-label="Preview this wallpaper in the browser"
        >
          PREVIEW
        </button>
      )}
      <button
        type="button"
        className={`lib-act lib-act-danger mono${confirming ? " is-armed" : ""}`}
        onClick={() => {
          if (confirming) {
            if (timer.current) clearTimeout(timer.current)
            setConfirming(false)
            intents.remove(row.workshop_id)
          } else {
            setConfirming(true)
            timer.current = setTimeout(() => setConfirming(false), 2200)
          }
        }}
      >
        {confirming ? "SURE?" : "DELETE"}
      </button>
    </span>
  )
}

/* ── Desktop ─────────────────────────────────────────────────────── */

type LibSort = "recent" | "title" | "size"
type LibView = "grid" | "list"
type StateFilter = "transcoded" | "source" | "attention"

const SORT_ROWS: ReadonlyArray<{ value: LibSort; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "title", label: "Title" },
  { value: "size", label: "Size" },
]

const VIEW_ROWS: ReadonlyArray<{ value: LibView; label: string }> = [
  { value: "grid", label: "Grid" },
  { value: "list", label: "List" },
]

const STATE_ROWS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: "transcoded", label: "Transcoded" },
  { value: "source", label: "Source only" },
  { value: "attention", label: "Needs attention" },
]

const matchesState = (row: LibraryItem, s: StateFilter): boolean =>
  s === "transcoded"
    ? row.transcode_status === "completed"
    : s === "source"
      ? row.transcode_status === "skipped"
      : row.transcode_status === "failed"

/** One rail ledger row: name left, dotted leader, ●/○ (selection) or →
 *  (command) aligned to the rail's right edge. */
const RailRow = ({
  label,
  mark,
  on = false,
  onClick,
}: {
  label: string
  mark: string
  on?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={`lib-rc-row mono${on ? " is-on" : ""}`}
    // Only selection rows are toggles; → command rows carry no pressed state.
    {...(mark === "→" ? {} : { "aria-pressed": on })}
    onClick={onClick}
  >
    <span className="lib-rc-row-name">{label}</span>
    <span className="lib-rc-row-dots" aria-hidden="true" />
    <span className={mark === "→" ? "lib-rc-cmd-mark" : "lib-rc-row-mark"}>{mark}</span>
  </button>
)

const LibraryDesktop = ({ nowPlayingId, onSystemRefresh }: Props) => {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<LibSort>("recent")
  const [view, setView] = useState<LibView>("grid")
  const [states, setStates] = useState<ReadonlyArray<StateFilter>>([])
  const [showAdult, setShowAdult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<LibraryItem | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLElement | null>(null)
  const gridRef = useRef<HTMLElement | null>(null)
  // Stable callback ref (see Browse.tsx: an inline closure detaches every
  // render and child layout effects read the ref inside that null window).
  const setGridRef = useCallback((el: HTMLElement | null) => {
    gridRef.current = el
  }, [])
  const queryRef = useRef<HTMLInputElement | null>(null)
  const columnsPerRow = useColumnsPerRow(gridRef, MIN_CARD_WIDTH, GRID_GAP)

  const { data: rows = [], error: loadError, isLoading, mutate } = useLibraryRows()
  const intents = useIntents(
    () => mutate().then(() => undefined),
    onSystemRefresh,
    setError,
    setNotice
  )

  /* ── View dual-state + glass detail popover (ticket 08, spec §4.2).
     Same keyboard/roaming paradigm as Browse (tickets 05/06). ── */
  const [cursor, setCursor] = useState(0)
  const [detailIdx, setDetailIdx] = useState<number | null>(null)
  // Enter confirm beat (spec §4.1 Q 方案): true during the ~120ms
  // dither-out / XOR-in flip before the open transition runs.
  const [commit, setCommit] = useState(false)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [detailVt, setDetailVt] = useState(false)
  const [detailClosing, setDetailClosing] = useState(false)
  const detailCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = rows.filter((r) => !q || r.title.toLowerCase().includes(q))
    if (!showAdult) list = list.filter((r) => !isAdultRow(r))
    if (states.length) list = list.filter((r) => states.some((s) => matchesState(r, s)))
    if (sort === "title") list = [...list].sort((a, b) => a.title.localeCompare(b.title))
    else if (sort === "size") list = [...list].sort((a, b) => playableSize(b) - playableSize(a))
    else list = [...list].sort((a, b) => b.downloaded_at - a.downloaded_at)
    return list
  }, [rows, query, showAdult, states, sort])

  const totalSize = useMemo(() => items.reduce((sum, r) => sum + playableSize(r), 0), [items])
  const clampedCursor = items.length > 0 ? Math.min(cursor, items.length - 1) : 0
  const detailItem = detailIdx !== null ? items[detailIdx] : undefined

  // The media element the detail popover morphs out of / the close ghost
  // flies back to: the card media in grid view, the row thumb in list view.
  const sourceMediaEl = (i: number): HTMLElement | null => {
    const root = rootRef.current
    if (!root) return null
    const cell = root.querySelectorAll(view === "grid" ? ".lib-card" : ".ledger-row")[i]
    return (
      cell?.querySelector<HTMLElement>(view === "grid" ? ".lib-media" : ".ledger-thumb") ?? null
    )
  }

  // Open direction = View Transition (spec §2.5 / §5 F3): only the media is
  // named (lib-card-media — the Library variant of Browse's card-media
  // recipe, with a top-corners-only landing radius). The callback awaits
  // the detail <img> decode so the browser never snapshots a blank box
  // (400ms cap). No VT API (Safari) or reduced motion: instant swap.
  const openDetail = (i: number) => {
    const el = sourceMediaEl(i)
    const useVt = el !== null && canViewTransition()
    if (useVt && el) el.style.viewTransitionName = "lib-card-media"
    withViewTransition(() => {
      if (useVt && el) el.style.viewTransitionName = ""
      flushSync(() => {
        setDetailVt(useVt)
        setDetailIdx(i)
      })
      if (!useVt) return
      const img = document.querySelector<HTMLImageElement>(".ldet-media img")
      if (!img) return
      const decoded =
        img.complete && img.naturalWidth > 0
          ? img.decode().catch(() => {})
          : new Promise<void>((resolve) => {
              const done = () => resolve()
              img.addEventListener(
                "load",
                () => void img.decode().then(done, done),
                { once: true }
              )
              img.addEventListener("error", done, { once: true })
            })
      return Promise.race([decoded, new Promise<void>((r) => setTimeout(r, 400))])
    })
  }

  const stepDetail = (dir: 1 | -1) =>
    setDetailIdx((f) =>
      f === null || items.length === 0 ? f : (f + dir + items.length) % items.length
    )

  // Enter confirm beat (spec §4.1): the ring's checkerboard band fades out
  // while the XOR block fades in over ~120ms, THEN the VT open runs.
  const openWithConfirm = (i: number) => {
    if (commitTimer.current !== null) return
    if (prefersReducedMotion()) {
      openDetail(i)
      return
    }
    setCommit(true)
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null
      openDetail(i)
    }, FOCUS_CONFIRM_MS)
  }

  // Close direction = FLIP ghost (spec §5 F6), the mirror of the VT open:
  // the detail media flies back into its source cell while the chrome
  // plays the 150ms exit beat (F1). Reduced motion: instant cut.
  const requestClose = () => {
    if (detailIdx === null || detailClosing) return
    setCommit(false)
    setCursor(detailIdx)
    if (!prefersReducedMotion()) {
      const detailMedia = document.querySelector<HTMLElement>(".ldet-media")
      const target = sourceMediaEl(detailIdx)
      const img = detailMedia?.querySelector("img")
      if (detailMedia && target && img) {
        const from = detailMedia.getBoundingClientRect()
        const to = target.getBoundingClientRect()
        if (to.width > 0 && to.height > 0) {
          detailMedia.style.opacity = "0"
          flyGhost({ from, to, src: img.src, duration: duration.base, fromRadius: "20px" })
        }
      }
    }
    setDetailClosing(true)
    detailCloseTimer.current = setTimeout(() => {
      detailCloseTimer.current = null
      setDetailClosing(false)
      setDetailVt(false)
      setDetailIdx(null)
    }, duration.exit)
  }

  useEffect(
    () => () => {
      if (detailCloseTimer.current) clearTimeout(detailCloseTimer.current)
      if (commitTimer.current) clearTimeout(commitTimer.current)
    },
    []
  )

  // Deleting the open item closes the popover immediately (the item is
  // gone from the list, so there is nothing left to fly back to).
  const deleteFromDetail = (id: string) => {
    intents.remove(id)
    setDetailClosing(false)
    setDetailVt(false)
    setDetailIdx(null)
  }

  // Keyboard (desktop): V toggles grid ↔ list; arrows roam (grid uses the
  // measured column count) with the shared 1-bit focus band; Enter plays
  // the confirm beat, then opens the glass detail. While the detail is
  // open, ←/→ steps and Esc closes. ⌘K focuses the rail QUERY input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        queryRef.current?.focus()
        queryRef.current?.select()
        return
      }
      if (t?.closest("input, textarea, [contenteditable]")) return
      if (detailIdx !== null) {
        if (e.key === "Escape") {
          e.preventDefault()
          requestClose()
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault()
          stepDetail(e.key === "ArrowLeft" ? -1 : 1)
        }
        return
      }
      if (e.key === "v" || e.key === "V") {
        setView((v) => (v === "grid" ? "list" : "grid"))
        return
      }
      if (items.length === 0) return
      const cols = view === "grid" ? columnsPerRow : 1
      const move = (dx: number, dy: number) => {
        e.preventDefault()
        setCursor((c) => {
          const col = c % cols
          const row = Math.floor(c / cols)
          const lastRow = Math.ceil(items.length / cols) - 1
          const nc = Math.min(cols - 1, Math.max(0, col + dx))
          const nr = Math.min(lastRow, Math.max(0, row + dy))
          return Math.min(items.length - 1, nr * cols + nc)
        })
      }
      switch (e.key) {
        case "ArrowLeft":
          move(-1, 0)
          break
        case "ArrowRight":
          move(1, 0)
          break
        case "ArrowUp":
          move(0, -1)
          break
        case "ArrowDown":
          move(0, 1)
          break
        case "Enter":
          // Let a focused button/link keep its native Enter activation.
          if (t?.closest("button, a")) return
          e.preventDefault()
          openWithConfirm(clampedCursor)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // Keep the keyboard cursor visible while roaming.
  useEffect(() => {
    if (detailIdx !== null) return
    const root = rootRef.current
    const el = root?.querySelectorAll(view === "grid" ? ".lib-card" : ".ledger-row")[
      clampedCursor
    ]
    ;(el as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" })
  }, [view, clampedCursor, detailIdx])

  // Header parallax fade (spec §2.5), same driver as Browse: inline style
  // writes from the scroller's native scroll events, skipped under
  // reduced motion.
  useEffect(() => {
    if (prefersReducedMotion()) return
    const head = headRef.current
    const scroller = head?.closest(".main")
    if (!head || !scroller) return
    let raf = 0
    const update = () => {
      raf = 0
      const s = scroller.scrollTop
      const p = Math.min(1, Math.max(0, s / 320))
      head.style.transform = `translateY(${(-s * 0.12).toFixed(1)}px)`
      head.style.opacity = String(1 - p * 0.85)
    }
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(update)
    }
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      scroller.removeEventListener("scroll", onScroll)
      if (raf !== 0) cancelAnimationFrame(raf)
      head.style.transform = ""
      head.style.opacity = ""
    }
  }, [])

  // Start a rotation over the safe (non-adult) library: set the mode, then
  // play the anchor so the backend arms the timer from it.
  const playRotation = (mode: "sequential" | "shuffle") => {
    const safeRows = rows.filter((r) => !isAdultRow(r))
    const start =
      mode === "shuffle"
        ? safeRows[Math.floor(Math.random() * safeRows.length)]
        : safeRows[0]
    if (!start) return
    api
      .playerMode(mode)
      .then(() => api.play(start.workshop_id))
      .then(() => {
        setError(null)
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))
  }

  const transcodeAll = () =>
    api
      .libraryTranscodeRetryAll()
      .then(async (res) => {
        setError(null)
        setNotice(`Transcode sweep: ${res.queued} queued, ${res.skipped} skipped`)
        await mutate()
      })
      .catch((e: Error) => setError(e.message))

  const toggleState = (s: StateFilter) =>
    setStates((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  return (
    <div className="lib" ref={rootRef}>
      <RailControls>
        <div className="lib-rc-query">
          <label className="lib-rc-title mono" htmlFor="lib-q">
            QUERY <span className="lib-rc-kbd mono">⌘K</span>
          </label>
          <input
            ref={queryRef}
            id="lib-q"
            type="text"
            value={query}
            placeholder="Filter the library…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div>
          <div className="lib-rc-title mono">SORT</div>
          {SORT_ROWS.map((o) => (
            <RailRow
              key={o.value}
              label={o.label}
              mark={sort === o.value ? "●" : "○"}
              on={sort === o.value}
              onClick={() => setSort(o.value)}
            />
          ))}
        </div>

        <div>
          <div className="lib-rc-title mono">VIEW</div>
          {VIEW_ROWS.map((o) => (
            <RailRow
              key={o.value}
              label={o.label}
              mark={view === o.value ? "●" : "○"}
              on={view === o.value}
              onClick={() => setView(o.value)}
            />
          ))}
        </div>

        <div>
          <div className="lib-rc-title mono">QUEUE</div>
          <RailRow label="Play all" mark="→" onClick={() => playRotation("sequential")} />
          <RailRow label="Shuffle" mark="→" onClick={() => playRotation("shuffle")} />
          <RailRow label="Transcode all" mark="→" onClick={transcodeAll} />
        </div>

        <div className="lib-rc-sec">
          <div className="lib-rc-sec-head mono">
            <span>FILTERS</span>
            {states.length > 0 && (
              <button
                type="button"
                className="lib-rc-sec-clear"
                onClick={() => setStates([])}
              >
                {states.length} ACTIVE — CLEAR
              </button>
            )}
          </div>
          <div>
            <div className="lib-rc-title mono">STATE</div>
            {STATE_ROWS.map((o) => (
              <RailRow
                key={o.value}
                label={o.label}
                mark={states.includes(o.value) ? "●" : "○"}
                on={states.includes(o.value)}
                onClick={() => toggleState(o.value)}
              />
            ))}
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
        </div>
      </RailControls>

      {view === "grid" && (
        <GridOverlay
          rootRef={rootRef}
          gridRef={gridRef}
          itemCount={items.length}
          cardSelector=".lib-card"
          heightVar="--lib-card-h"
        />
      )}

      <header className="lib-head pt-enter" ref={headRef}>
        <h1 className="lib-title">
          Library<span className="lib-title-slash"> / </span>Local
        </h1>
        <div className="lib-head-side">
          <span className="lib-view-hint mono">V — {view === "grid" ? "GRID" : "LIST"}</span>
          <span className="lib-count mono">
            {items.length} ITEMS — {formatBytes(totalSize).toUpperCase()}
          </span>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="info-banner">{notice}</div>}

      {isLoading && <StateBlock kind="loading" text="FETCHING LIBRARY…" />}
      {/* Page-level error only when the whole list failed to load (§3.3). */}
      {loadError != null && items.length === 0 && (
        <StateBlock
          kind="error"
          text={`ERR — ${(loadError as Error).message}`}
          onRetry={() => void mutate()}
        />
      )}

      {/* The wrapper owns gridRef in both views (keeps column measurement
          alive across the V toggle) and is the focus-ring host: positioned +
          isolating, the offsetParent for the ring and the roamed items. */}
      <div className="focus-ring-host" ref={setGridRef}>
        {items.length > 0 && (
          <FocusRing
            hostRef={gridRef}
            selector={view === "grid" ? ".lib-card" : ".ledger-row"}
            index={clampedCursor}
            columns={view === "grid" ? columnsPerRow : 1}
            commit={commit}
          />
        )}
        {view === "grid" ? (
          <section
            className="lib-grid"
            style={{ gridTemplateColumns: `repeat(${columnsPerRow}, minmax(0, 1fr))` }}
          >
            {items.map((row, i) => (
              <article
                key={row.workshop_id}
                className={`lib-card pt-enter${i === clampedCursor ? " lib-cursor" : ""}`}
                style={{ "--pt-i": i } as CSSProperties}
                onClick={() => setCursor(i)}
              >
                <div className="lib-card-index mono">
                  N°{String(i + 1).padStart(3, "0")}
                  {row.workshop_id === nowPlayingId && (
                    <span className="lib-now mono">NOW PLAYING</span>
                  )}
                </div>
                <div className="lib-media" onDoubleClick={() => openDetail(i)}>
                  {row.preview_url ? (
                    <img
                      className="lib-media-img"
                      src={row.preview_url}
                      alt={row.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className="lib-media-img lib-media-empty" />
                  )}
                  <TxPill row={row} />
                </div>
                <div className="lib-caption">
                  <span className="lib-caption-title" title={row.title}>
                    {row.title}
                  </span>
                  <span className="lib-caption-meta mono">{playableMeta(row)}</span>
                  <HoverActions row={row} intents={intents} onPreview={setPreviewItem} />
                </div>
              </article>
            ))}
          </section>
        ) : (
          <LedgerList>
            {items.map((row, i) => (
              <LedgerRow
                key={row.workshop_id}
                no={String(i + 1).padStart(3, "0")}
                thumb={row.preview_url || null}
                title={
                  <>
                    {row.title}
                    {row.workshop_id === nowPlayingId && (
                      <span className="lib-now mono">NOW PLAYING</span>
                    )}
                  </>
                }
                meta={playableMeta(row)}
                cursor={i === clampedCursor}
                onSelect={() => setCursor(i)}
                onOpen={() => openDetail(i)}
                action={
                  <>
                    <TxPill row={row} inline />
                    <HoverActions row={row} intents={intents} onPreview={setPreviewItem} />
                  </>
                }
              />
            ))}
          </LedgerList>
        )}
      </div>

      {!isLoading && items.length === 0 && !loadError && (
        <StateBlock
          kind="empty"
          text={
            rows.length === 0
              ? "LIBRARY EMPTY — ADD WALLPAPERS IN BROWSE"
              : "0 ITEMS — WIDEN QUERY OR CLEAR FILTERS"
          }
        />
      )}

      {detailItem !== undefined && detailIdx !== null && (
        <LibraryDetail
          row={detailItem}
          nowPlaying={detailItem.workshop_id === nowPlayingId}
          vt={detailVt}
          closing={detailClosing}
          intents={intents}
          onPreview={setPreviewItem}
          onDelete={deleteFromDetail}
          onRequestClose={requestClose}
          onStep={stepDetail}
        />
      )}

      {previewItem && <VideoPreview item={previewItem} onClose={() => setPreviewItem(null)} />}
    </div>
  )
}

/* ── Glass detail popover (spec §4.2 / §2.4): SOURCE / OPTIMIZED double
     spec line + PLAY / PREVIEW / TRANSCODE / DELETE / STEAM. ── */

const LibraryDetail = ({
  row,
  nowPlaying,
  vt,
  closing,
  intents,
  onPreview,
  onDelete,
  onRequestClose,
  onStep,
}: {
  row: LibraryItem
  nowPlaying: boolean
  vt: boolean
  closing: boolean
  intents: Intents
  onPreview: (row: LibraryItem) => void
  onDelete: (id: string) => void
  onRequestClose: () => void
  onStep: (dir: 1 | -1) => void
}) => {
  const [confirming, setConfirming] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const saved = spaceSavedPercent(row)
  const added = new Date(row.downloaded_at).toISOString().slice(0, 10)
  const optimized = row.transcoded_resolution !== null && row.transcoded_size !== null

  return (
    <div className="ldet">
      <div
        className={`ldet-scrim${closing ? " ldet-scrim-out" : ""}`}
        onClick={onRequestClose}
      />
      <div
        className={`ldet-panel${vt ? " ldet-vt" : ""}${closing ? " ldet-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={row.title}
      >
        <button
          type="button"
          className="ldet-close"
          aria-label="Close detail"
          autoFocus
          onClick={onRequestClose}
        >
          ✕
        </button>
        <div className="ldet-media">
          {row.preview_url ? <img src={row.preview_url} alt={row.title} /> : null}
          {nowPlaying && <span className="lib-now ldet-now mono">NOW PLAYING</span>}
          <TxPill row={row} />
        </div>
        <div className="ldet-body">
          <h2 className="ldet-title">{row.title}</h2>
          <div className="ldet-meta mono">
            ID {row.workshop_id} · ADDED {added}
          </div>
          <div className="ldet-specs mono">
            <span>
              SOURCE — {row.source_resolution} · {row.source_codec.toUpperCase()} ·{" "}
              {formatBytes(row.source_size)}
            </span>
            {optimized && (
              <span>
                OPTIMIZED — {row.transcoded_resolution} ·{" "}
                {(row.transcoded_codec ?? "").toUpperCase()} ·{" "}
                {formatBytes(row.transcoded_size ?? 0)}
                {saved !== null && saved > 0 ? ` · ↓${saved}%` : ""}
              </span>
            )}
            {!optimized && row.transcode_status === "skipped" && (
              <span>OPTIMIZED — SKIPPED</span>
            )}
            {row.transcode_status === "failed" && (
              <span className="ldet-specs-err">OPTIMIZED — FAILED</span>
            )}
          </div>
          <div className="ldet-actions">
            <button
              type="button"
              className="ldet-play mono"
              onClick={() => intents.play(row.workshop_id)}
            >
              PLAY
            </button>
            {canPreview(row) && (
              <button
                type="button"
                className="ldet-cmd mono"
                onClick={() => onPreview(row)}
                aria-label="Preview this wallpaper in the browser"
              >
                PREVIEW
              </button>
            )}
            {canRetranscode(row.transcode_status) && (
              <button
                type="button"
                className="ldet-cmd mono"
                onClick={() => intents.transcode(row.workshop_id)}
              >
                TRANSCODE
              </button>
            )}
            <button
              type="button"
              className={`ldet-cmd ldet-danger mono${confirming ? " is-armed" : ""}`}
              onClick={() => {
                if (confirming) {
                  if (timer.current) clearTimeout(timer.current)
                  onDelete(row.workshop_id)
                } else {
                  setConfirming(true)
                  timer.current = setTimeout(() => setConfirming(false), 2200)
                }
              }}
            >
              {confirming ? "SURE?" : "DELETE"}
            </button>
            <a
              className="ldet-steam mono"
              href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.workshop_id}`}
              target="_blank"
              rel="noreferrer"
            >
              STEAM ↗
            </a>
            <div className="ldet-step">
              <button type="button" onClick={() => onStep(-1)}>
                ‹ PREV
              </button>
              <button type="button" onClick={() => onStep(1)}>
                NEXT ›
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Mobile: the pre-redesign layout stays untouched (mobile pages are
     out of the redesign scope, spec §9). Grid only, same legacy classes. ── */

const LibraryMobile = ({ nowPlayingId, onSystemRefresh }: Props) => {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<LibraryItem | null>(null)
  const { data: rows = [], mutate } = useLibraryRows()
  const intents = useIntents(
    () => mutate().then(() => undefined),
    onSystemRefresh,
    setError,
    setNotice
  )

  const adultCount = useMemo(() => rows.filter(isAdultRow).length, [rows])
  const visibleRows = useMemo(
    () => (showAdult ? rows : rows.filter((row) => !isAdultRow(row))),
    [rows, showAdult]
  )
  const totalSize = useMemo(
    () => visibleRows.reduce((sum, row) => sum + playableSize(row), 0),
    [visibleRows]
  )

  const playRotation = (mode: "sequential" | "shuffle") => {
    const safeRows = rows.filter((r) => !isAdultRow(r))
    const start =
      mode === "shuffle"
        ? safeRows[Math.floor(Math.random() * safeRows.length)]
        : safeRows[0]
    if (!start) return
    api
      .playerMode(mode)
      .then(() => api.play(start.workshop_id))
      .then(() => {
        setError(null)
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))
  }

  const transcodeAll = () =>
    api
      .libraryTranscodeRetryAll()
      .then(async (res) => {
        setError(null)
        setNotice(`Transcode sweep: ${res.queued} queued, ${res.skipped} skipped`)
        await mutate()
      })
      .catch((e: Error) => setError(e.message))

  const countLabel = `${visibleRows.length} wallpaper${visibleRows.length === 1 ? "" : "s"} · ${formatBytes(totalSize)}`

  return (
    <div className="page library-page">
      <header className="page-header library-page-header">
        <div className="library-page-title-block">
          <h1 className="page-title">Library</h1>
          <span className="page-count mono">{countLabel}</span>
        </div>
        <div className="page-actions">
          {visibleRows.length > 0 && (
            <div className="library-rotation-actions">
              <button
                type="button"
                className="btn library-rotation-btn"
                onClick={() => playRotation("sequential")}
              >
                <span className="btn-icon">{appIcons.modeSequential}</span>
                Play all
              </button>
              <button
                type="button"
                className="btn library-rotation-btn"
                onClick={() => playRotation("shuffle")}
              >
                <span className="btn-icon">{appIcons.modeShuffle}</span>
                Shuffle
              </button>
              {rows.some((row) => canRetranscode(row.transcode_status)) && (
                <button
                  type="button"
                  className="btn library-rotation-btn"
                  onClick={transcodeAll}
                >
                  Transcode all
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className={`library-secret-trigger ${privacyOpen ? "active" : ""}`}
            aria-label={privacyOpen ? "Hide privacy filter" : "Show privacy filter"}
            aria-expanded={privacyOpen}
            onClick={() => setPrivacyOpen((open) => !open)}
          >
            ••
          </button>
        </div>
      </header>

      <div className={`library-privacy-shell ${privacyOpen ? "open" : ""}`}>
        <div className="library-privacy-panel">
          <div className="library-privacy-copy">
            <div className="library-privacy-title mono">safe shelf</div>
            <div className="library-privacy-note">
              {adultCount > 0
                ? showAdult
                  ? "All saved wallpapers are visible in this session."
                  : `${adultCount} mature item${adultCount === 1 ? "" : "s"} hidden in this session.`
                : "No mature-marked wallpapers found."}
            </div>
          </div>
          <div className="segmented segmented-compact library-privacy-toggle">
            <button
              type="button"
              className={`segmented-button ${!showAdult ? "active" : ""}`}
              aria-pressed={!showAdult}
              onClick={() => setShowAdult(false)}
            >
              Safe
            </button>
            <button
              type="button"
              className={`segmented-button ${showAdult ? "active" : ""}`}
              aria-pressed={showAdult}
              onClick={() => setShowAdult(true)}
            >
              All
            </button>
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="info-banner">{notice}</div>}
      {visibleRows.length === 0 && (
        <div className="empty-state">Library is empty. Download some wallpapers in Browse.</div>
      )}

      {visibleRows.length > 0 && (
        <div className="library-grid">
          {visibleRows.map((row) => {
            const active = row.workshop_id === nowPlayingId
            const tx = txLabel(row)
            const savedPct = spaceSavedPercent(row)
            return (
              <article
                key={row.workshop_id}
                className={`library-card ${active ? "library-card-active" : ""}`}
              >
                <div className="library-card-media">
                  {row.preview_url ? (
                    <img
                      className="library-card-thumb"
                      src={row.preview_url}
                      alt={row.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className="library-card-thumb library-card-thumb-empty" />
                  )}
                  {active && <span className="library-playing-pill">● Now playing</span>}
                  {tx && (
                    <span className={`library-card-badge status-pill-${row.transcode_status} mono`}>
                      {row.transcode_status}
                    </span>
                  )}
                  {!tx && savedPct !== null && (
                    <span className="library-card-badge status-pill-completed mono">
                      ↓ saved {savedPct}%
                    </span>
                  )}
                  <div className="library-card-overlay">
                    <div className="library-card-title" title={row.title}>
                      {row.title}
                    </div>
                    <div className="library-card-meta mono">
                      {playableResolution(row)} · {playableCodec(row)} ·{" "}
                      {formatBytes(playableSize(row))}
                    </div>
                  </div>
                </div>
                <div className="library-card-body">
                  <button
                    type="button"
                    className="btn btn-primary library-card-play"
                    onClick={() => intents.play(row.workshop_id)}
                  >
                    <span className="library-card-play-icon">{appIcons.play}</span>
                    Play
                  </button>
                  {canPreview(row) && (
                    <button
                      type="button"
                      className="btn library-card-preview"
                      onClick={() => setPreviewItem(row)}
                      aria-label="Preview this wallpaper in the browser"
                    >
                      ▶
                    </button>
                  )}
                  {canRetranscode(row.transcode_status) && (
                    <button
                      type="button"
                      className="btn library-card-transcode"
                      onClick={() => intents.transcode(row.workshop_id)}
                      aria-label="Transcode this wallpaper"
                    >
                      ⟳
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost-danger library-card-delete"
                    onClick={() => {
                      if (confirm("Delete this wallpaper from library? Source file will be removed."))
                        intents.remove(row.workshop_id)
                    }}
                    aria-label="Delete from library"
                  >
                    ✕
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {previewItem && <VideoPreview item={previewItem} onClose={() => setPreviewItem(null)} />}
    </div>
  )
}

export const Library = (props: Props) => {
  const { mobile } = useLayout()
  return mobile ? <LibraryMobile {...props} /> : <LibraryDesktop {...props} />
}
