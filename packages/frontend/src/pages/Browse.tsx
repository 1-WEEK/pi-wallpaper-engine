import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import useSWRInfinite from "swr/infinite"
import { useLocation, useSearch } from "wouter"
import type { WorkshopItem } from "@pwe/shared"
import { api, type WorkshopSearchResult } from "../api.js"
import { WallpaperCard } from "../components/WallpaperCard.js"
import { appIcons } from "../icons.js"
import { useLayout } from "../components/mobile/index.js"
import { useColumnsPerRow } from "../useColumnsPerRow.js"
import { MobileSheet } from "../components/mobile/index.js"
import {
  AGE_TAGS,
  GENRE_TAGS,
  RESOLUTION_TAGS,
  SORT_OPTIONS,
  type WorkshopSort,
} from "../workshopTags.js"

const MIN_CARD_WIDTH = 248
const GRID_GAP = 14
const ROWS_PER_FETCH = 4
const PAGE_SIZE = 25

// URL search params are the source of truth. localStorage is only consulted
// once per page load: if the URL has no filter params at boot, we restore the
// last saved filter. After that the URL drives state — clearing filters and
// switching tabs will not "resurrect" old chips.
const STORAGE_KEY = "pwe.browse.state"
let hasBooted = false

interface PersistedState {
  query: string
  tags: ReadonlyArray<string>
  sort: WorkshopSort
}

const loadPersisted = (): PersistedState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { query: "", tags: ["Everyone"], sort: "trend" }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      query: parsed.query ?? "",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      sort: parsed.sort === "recent" ? "recent" : "trend",
    }
  } catch {
    return { query: "", tags: [], sort: "trend" }
  }
}

const parseSort = (raw: string | null): WorkshopSort =>
  raw === "recent" ? "recent" : "trend"

const parseTags = (raw: string | null): ReadonlyArray<string> =>
  raw ? raw.split(",").filter(Boolean) : []

const buildSearch = (
  query: string,
  tags: ReadonlyArray<string>,
  sort: WorkshopSort
): string => {
  const p = new URLSearchParams()
  if (query) p.set("q", query)
  if (tags.length) p.set("tags", tags.join(","))
  if (sort !== "trend") p.set("sort", sort)
  return p.toString()
}

export const Browse = () => {
  const search = useSearch()
  const [, setLocation] = useLocation()
  const params = new URLSearchParams(search)
  const { mobile } = useLayout()

  const submittedQuery = params.get("q") ?? ""
  const selectedTags = parseTags(params.get("tags"))
  const sort = parseSort(params.get("sort"))

  const gridRef = useRef<HTMLDivElement>(null)
  const columnsPerRow = useColumnsPerRow(gridRef, MIN_CARD_WIDTH, GRID_GAP)
  const pageSize = Math.max(PAGE_SIZE, columnsPerRow * ROWS_PER_FETCH)

  const hasUrlState = params.has("q") || params.has("tags") || params.has("sort")

  // Boot-time localStorage fallback. Runs at most once per full page load.
  useEffect(() => {
    if (hasBooted) return
    hasBooted = true
    if (hasUrlState) return
    const persisted = loadPersisted()
    const isDefault =
      !persisted.query && !persisted.tags.length && persisted.sort === "trend"
    if (isDefault) return
    const qs = buildSearch(persisted.query, persisted.tags, persisted.sort)
    setLocation(`/browse?${qs}`, { replace: true })
  }, [hasUrlState, setLocation])

  // Mirror current URL state to localStorage so the next page load can resume.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ query: submittedQuery, tags: selectedTags, sort })
      )
    } catch {
      // localStorage unavailable (private mode) — silently degrade
    }
  }, [submittedQuery, selectedTags.join(","), sort])

  // Local typing buffer for the search input; commits to URL on submit.
  const [queryDraft, setQueryDraft] = useState(submittedQuery)
  useEffect(() => {
    setQueryDraft(submittedQuery)
  }, [submittedQuery])

  // Mobile-only sheet state
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [cardItem, setCardItem] = useState<WorkshopItem | null>(null)

  const writeParams = (next: {
    query?: string
    tags?: ReadonlyArray<string>
    sort?: WorkshopSort
  }) => {
    const q = next.query !== undefined ? next.query : submittedQuery
    const t = next.tags !== undefined ? next.tags : selectedTags
    const s = next.sort !== undefined ? next.sort : sort
    const qs = buildSearch(q, t, s)
    setLocation(qs ? `/browse?${qs}` : "/browse")
  }

  const tagKey = [...selectedTags].sort().join(",")

  const getKey = (pageIndex: number, prev: WorkshopSearchResult | null) => {
    if (pageIndex > 0 && (!prev || !prev.nextCursor || prev.items.length < PAGE_SIZE)) {
      return null
    }
    const cursor = pageIndex === 0 ? "*" : (prev?.nextCursor ?? "*")
    return ["workshop-search", submittedQuery, tagKey, sort, cursor] as const
  }

  const { data, error, isLoading, isValidating, size, setSize } = useSWRInfinite(
    getKey,
    ([, q, tags, s, cursor]) =>
      api.workshopSearch(q, {
        cursor,
        pageSize,
        tags: tags ? tags.split(",") : [],
        sort: s as WorkshopSort,
      }),
    { revalidateFirstPage: false }
  )

  const { data: libraryRows = [] } = useSWR("library-list", api.libraryList, {
    refreshInterval: 5000,
    revalidateIfStale: true,
  })
  const { data: downloadTasks = [], mutate: mutateDownloadTasks } = useSWR(
    "download-tasks",
    api.downloadTasks,
    {
      refreshInterval: 1000,
      revalidateIfStale: true,
      dedupingInterval: 0,
    }
  )

  const libraryIds = useMemo(
    () => new Set(libraryRows.map((row) => row.workshop_id)),
    [libraryRows]
  )
  const downloadTasksById = useMemo(
    () => new Map(downloadTasks.map((task) => [task.workshop_id, task])),
    [downloadTasks]
  )

  const pages = data ?? []
  const items = pages.flatMap((p) => p.items)
  const total = pages[0]?.total ?? 0
  const lastPage = pages[pages.length - 1]
  const hasMore =
    !!lastPage && !!lastPage.nextCursor && lastPage.items.length >= PAGE_SIZE
  const isLoadingMore = isValidating && pages.length > 0 && pages.length < size

  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag]
    writeParams({ tags: next })
  }

  const clearTags = () => writeParams({ tags: [] })

  const searchInput = (
    <label className="command-bar-input">
      <span className="command-bar-search-icon">{appIcons.browse}</span>
      <input
        type="text"
        placeholder={mobile ? "Search wallpapers…" : "Search Wallpaper Engine video wallpapers…"}
        value={queryDraft}
        onChange={(e) => setQueryDraft(e.target.value)}
      />
      {queryDraft && (
        <button
          type="button"
          className="command-bar-clear mono"
          onClick={() => {
            setQueryDraft("")
            if (submittedQuery) writeParams({ query: "" })
          }}
        >
          Clear
        </button>
      )}
    </label>
  )

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-kicker mono">Steam Workshop video wallpapers</div>
          <h1 className="page-title">Browse</h1>
        </div>
        <div className="page-header-meta mono">
          {total > 0 ? `${total.toLocaleString()} results` : "Search ready"}
        </div>
      </header>

      <form
        className="command-bar"
        action={() => {
          writeParams({ query: queryDraft })
        }}
      >
        {mobile ? (
          <div className="browse-mobile-search-row">
            {searchInput}
            <button
              type="button"
              className={`browse-mobile-filters-pill ${selectedTags.length > 0 ? "has-active" : ""}`}
              onClick={() => setFiltersOpen(true)}
              aria-label="Open filters"
            >
              <span aria-hidden="true">{appIcons.sliders}</span>
              Filters
              {selectedTags.length > 0 && (
                <span className="browse-mobile-filters-pill-badge mono">
                  {selectedTags.length}
                </span>
              )}
            </button>
          </div>
        ) : (
          <>
            {searchInput}
            <button type="submit" className="btn btn-primary command-bar-submit">
              Search
            </button>
            <div className="command-bar-sort">
              <span className="mono">sort</span>
              <div className="segmented segmented-compact command-bar-sort-toggle" role="tablist" aria-label="Sort results">
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`segmented-button ${sort === o.value ? "active" : ""}`}
                    aria-pressed={sort === o.value}
                    onClick={() => writeParams({ sort: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <span className="kbd mono">⌘K</span>
          </>
        )}
      </form>

      {mobile && selectedTags.length > 0 && (
        <div className="browse-mobile-selected-row">
          {selectedTags.map((t) => (
            <button
              key={t}
              type="button"
              className="chip chip-active"
              onClick={() => toggleTag(t)}
            >
              {t}
              <span className="chip-remove" aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}

      {!mobile && (
        <div className="filter-stack">
          <div className="filter-group">
            <span className="filter-group-label mono">Genre</span>
            <div className="filter-chips">
              {GENRE_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`chip ${selectedTags.includes(tag) ? "chip-active" : ""}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <span className="filter-group-label mono">Resolution</span>
            <div className="filter-chips">
              {RESOLUTION_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`chip ${selectedTags.includes(tag) ? "chip-active" : ""}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <span className="filter-group-label mono">Age</span>
            <div className="filter-chips">
              {AGE_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`chip ${selectedTags.includes(tag) ? "chip-active" : ""}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
              {selectedTags.length > 0 && (
                <button type="button" className="chip chip-clear" onClick={clearTags}>
                  Clear {selectedTags.length}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isLoading && <div className="empty-state">Loading workshop results…</div>}
      {error && <div className="error-banner">Error: {(error as Error).message}</div>}

      <div ref={gridRef} className="grid browse-grid">
        {items.map((it) => (
          <WallpaperCard
            key={it.publishedfileid}
            item={it}
            isInLibrary={libraryIds.has(it.publishedfileid)}
            downloadTask={downloadTasksById.get(it.publishedfileid)}
            onDownloadQueued={() => {
              void mutateDownloadTasks()
            }}
            onOpen={mobile ? () => setCardItem(it) : undefined}
          />
        ))}
      </div>

      {!isLoading && items.length === 0 && !error && (
        <div className="empty-state">No results. Try a different search or fewer filters.</div>
      )}

      {hasMore && (
        <div className="load-more load-more-spaced">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={isLoadingMore}
            onClick={() => setSize(size + 1)}
          >
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}

      {/* Mobile filters sheet */}
      <MobileSheet
        open={mobile && filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        action={
          selectedTags.length > 0 ? (
            <button
              type="button"
              className="filters-sheet-reset"
              onClick={() => {
                clearTags()
              }}
            >
              Reset
            </button>
          ) : null
        }
      >
        <FiltersSheetBody
          selectedTags={selectedTags}
          sort={sort}
          onToggle={toggleTag}
          onSort={(s) => writeParams({ sort: s })}
          total={total}
          onApply={() => setFiltersOpen(false)}
        />
      </MobileSheet>

      {/* Mobile card detail sheet */}
      <MobileSheet
        open={mobile && !!cardItem}
        onClose={() => setCardItem(null)}
        height="94%"
      >
        {cardItem && (
          <CardDetailBody
            item={cardItem}
            isInLibrary={libraryIds.has(cardItem.publishedfileid)}
            downloadTask={downloadTasksById.get(cardItem.publishedfileid)}
            onClose={() => setCardItem(null)}
            onDownloadQueued={() => {
              void mutateDownloadTasks()
            }}
          />
        )}
      </MobileSheet>
    </div>
  )
}

const FiltersSheetBody = ({
  selectedTags,
  sort,
  onToggle,
  onSort,
  total,
  onApply,
}: {
  selectedTags: ReadonlyArray<string>
  sort: WorkshopSort
  onToggle: (tag: string) => void
  onSort: (sort: WorkshopSort) => void
  total: number
  onApply: () => void
}) => {
  const groups: ReadonlyArray<{ label: string; tags: ReadonlyArray<string> }> = [
    { label: "Genre", tags: GENRE_TAGS },
    { label: "Resolution", tags: RESOLUTION_TAGS },
    { label: "Age", tags: AGE_TAGS },
  ]
  return (
    <div className="filters-sheet-body">
      <div className="filters-sheet-group">
        <div className="filters-sheet-group-label">Sort</div>
        <div className="segmented" role="tablist" aria-label="Sort results">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`segmented-button ${sort === o.value ? "active" : ""}`}
              aria-pressed={sort === o.value}
              onClick={() => onSort(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {groups.map((g) => (
        <div key={g.label} className="filters-sheet-group">
          <div className="filters-sheet-group-label">{g.label}</div>
          <div className="filters-sheet-chips">
            {g.tags.map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${selectedTags.includes(t) ? "chip-active" : ""}`}
                onClick={() => onToggle(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="mobile-sheet-footer">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onApply}
        >
          {total > 0 ? `Show ${total.toLocaleString()} results` : "Apply"}
        </button>
      </div>
    </div>
  )
}

const formatFileSize = (raw: WorkshopItem["file_size"]): string | null => {
  if (raw === undefined) return null
  const bytes = typeof raw === "string" ? parseInt(raw, 10) : raw
  if (!Number.isFinite(bytes)) return null
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const pickTagLabel = (item: WorkshopItem): string | null => {
  const tags = item.tags?.map((t) => t.tag).filter(Boolean) ?? []
  if (tags.length === 0) return null
  const preferred = tags.find((t) => t !== "Video")
  return preferred ?? tags[0] ?? null
}

const CardDetailBody = ({
  item,
  isInLibrary,
  downloadTask,
  onClose,
  onDownloadQueued,
}: {
  item: WorkshopItem
  isInLibrary: boolean
  downloadTask?: import("../api.js").DownloadTask
  onClose: () => void
  onDownloadQueued: () => void
}) => {
  const [starting, setStarting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const steamUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`
  const tagLabel = pickTagLabel(item)
  const size = formatFileSize(item.file_size)
  const finished =
    downloadTask?.stage === "complete" || downloadTask?.stage === "error"
  const activeStage = downloadTask && !finished ? downloadTask.stage : null
  const ready = isInLibrary || downloadTask?.stage === "complete"

  const onDownload = () => {
    setStarting(true)
    setErr(null)
    api
      .download(item.publishedfileid)
      .then(() => {
        onDownloadQueued()
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setStarting(false))
  }

  return (
    <div className="card-sheet-body">
      <div className="card-sheet-hero">
        {item.preview_url ? (
          <img src={item.preview_url} alt={item.title} loading="lazy" />
        ) : (
          <div style={{ width: "100%", height: "100%" }} />
        )}
        <button
          type="button"
          className="card-sheet-hero-close"
          onClick={onClose}
          aria-label="Close"
        >
          {appIcons.close}
        </button>
      </div>
      <div className="card-sheet-title-block">
        <div className="card-sheet-title">{item.title}</div>
        <div className="card-sheet-id mono">
          {item.publishedfileid}
          {item.creator && <> · {item.creator}</>}
        </div>
      </div>
      <div className="card-sheet-meta">
        <MetaItem k="Genre" v={tagLabel ?? "—"} />
        <MetaItem k="Size" v={size ?? "—"} mono />
        <MetaItem k="Status" v={ready ? "in library" : activeStage ?? "available"} />
        <MetaItem k="ID" v={item.publishedfileid} mono />
      </div>
      {!ready && (
        <div className="card-sheet-meta-note mono">
          Resolution/codec available after download.
        </div>
      )}
      {item.description && (
        <div style={{ padding: "16px 22px 0", fontSize: 13, color: "var(--paper-dim)", lineHeight: 1.5 }}>
          {item.description.slice(0, 220)}
          {item.description.length > 220 ? "…" : ""}
        </div>
      )}
      <div className="card-sheet-actions">
        {ready ? (
          <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
            Open Steam {appIcons.externalLink}
          </a>
        ) : activeStage ? (
          <button type="button" className="btn btn-secondary" disabled>
            {activeStage}…
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting}
            onClick={onDownload}
          >
            {appIcons.downloadArrow}
            {starting ? "Queueing…" : "Download"}
          </button>
        )}
        <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
          Steam
        </a>
      </div>
      {err && (
        <div style={{ margin: "12px 22px 0", color: "var(--danger)", fontSize: 12 }}>
          {err}
        </div>
      )}
    </div>
  )
}

const MetaItem = ({
  k,
  v,
  mono,
}: {
  k: string
  v: string
  mono?: boolean
}) => (
  <div>
    <div className="mobile-meta-k mono">{k}</div>
    <div className={`mobile-meta-v ${mono ? "mono" : ""}`}>{v}</div>
  </div>
)
