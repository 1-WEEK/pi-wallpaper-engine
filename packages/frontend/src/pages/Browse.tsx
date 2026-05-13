import { useEffect, useState } from "react"
import useSWRInfinite from "swr/infinite"
import { useLocation, useSearch } from "wouter"
import { api, type WorkshopSearchResult } from "../api.js"
import { WallpaperCard } from "../components/WallpaperCard.js"
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

  const [libraryIds, setLibraryIds] = useState<Set<string>>(new Set())

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

  useEffect(() => {
    api.libraryList().then((rows) => setLibraryIds(new Set(rows.map((r) => r.workshop_id))))
  }, [])

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
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault()
          writeParams({ query: queryDraft })
        }}
      >
        <input
          type="text"
          placeholder="Search Wallpaper Engine video wallpapers..."
          value={queryDraft}
          onChange={(e) => setQueryDraft(e.target.value)}
        />
        <button type="submit">Search</button>
        <select
          value={sort}
          onChange={(e) => writeParams({ sort: e.target.value as WorkshopSort })}
          title="Sort"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </form>

      <div className="filters">
        <div className="filter-row">
          <span className="filter-label">Genre</span>
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
        <div className="filter-row">
          <span className="filter-label">Resolution</span>
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
        <div className="filter-row">
          <span className="filter-label">Age</span>
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
              Clear ({selectedTags.length})
            </button>
          )}
        </div>
      </div>

      {isLoading && <div className="loading">Loading...</div>}
      {error && <div className="error">Error: {(error as Error).message}</div>}
      {!isLoading && items.length > 0 && (
        <div className="result-summary">
          Showing {items.length}
          {total > 0 ? ` of ${total.toLocaleString()}` : ""}
        </div>
      )}
      <div className="grid">
        {items.map((it) => (
          <WallpaperCard
            key={it.publishedfileid}
            item={it}
            isInLibrary={libraryIds.has(it.publishedfileid)}
          />
        ))}
        {!isLoading && items.length === 0 && !error && (
          <div className="empty">No results. Try a different search or fewer filters.</div>
        )}
      </div>
      {hasMore && (
        <div className="load-more">
          <button
            type="button"
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
