import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import useSWRInfinite from "swr/infinite"
import { useLocation, useSearch } from "wouter"
import { api, type WorkshopSearchResult } from "../api.js"
import { WallpaperCard } from "../components/WallpaperCard.js"
import { appIcons } from "../icons.js"
import {
  AGE_TAGS,
  GENRE_TAGS,
  RESOLUTION_TAGS,
  SORT_OPTIONS,
  type WorkshopSort,
} from "../workshopTags.js"

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

  const submittedQuery = params.get("q") ?? ""
  const selectedTags = parseTags(params.get("tags"))
  const sort = parseSort(params.get("sort"))

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
        pageSize: PAGE_SIZE,
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
        onSubmit={(e) => {
          e.preventDefault()
          writeParams({ query: queryDraft })
        }}
        >
        <label className="command-bar-input">
          <span className="command-bar-search-icon">{appIcons.browse}</span>
          <input
            type="text"
            placeholder="Search Wallpaper Engine video wallpapers…"
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
      </form>

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

      {isLoading && <div className="empty-state">Loading workshop results…</div>}
      {error && <div className="error-banner">Error: {(error as Error).message}</div>}

      <div className="grid browse-grid">
        {items.map((it) => (
          <WallpaperCard
            key={it.publishedfileid}
            item={it}
            isInLibrary={libraryIds.has(it.publishedfileid)}
            downloadTask={downloadTasksById.get(it.publishedfileid)}
            onDownloadQueued={() => {
              void mutateDownloadTasks()
            }}
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
    </div>
  )
}
