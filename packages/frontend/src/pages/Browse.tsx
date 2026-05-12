import { useEffect, useState } from "react"
import useSWRInfinite from "swr/infinite"
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

// App.tsx unmounts <Browse /> when the user switches tabs, so local state
// would reset on every return. Persist filter/sort/query to localStorage so
// the user's chip selection survives navigation and page reloads.
const STORAGE_KEY = "pwe.browse.state"

interface PersistedState {
  query: string
  tags: ReadonlyArray<string>
  sort: WorkshopSort
}

const loadPersisted = (): PersistedState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { query: "", tags: [], sort: "trend" }
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

export const Browse = () => {
  const initial = loadPersisted()
  const [query, setQuery] = useState(initial.query)
  const [submittedQuery, setSubmittedQuery] = useState(initial.query)
  const [selectedTags, setSelectedTags] = useState<ReadonlyArray<string>>(initial.tags)
  const [sort, setSort] = useState<WorkshopSort>(initial.sort)
  const [libraryIds, setLibraryIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ query: submittedQuery, tags: selectedTags, sort })
      )
    } catch {
      // localStorage unavailable (private mode) — silently degrade
    }
  }, [submittedQuery, selectedTags, sort])

  // SWR key includes every parameter that affects the response. Tags are
  // sorted so the order user toggled them in doesn't fragment the cache.
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
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const clearTags = () => setSelectedTags([])

  return (
    <div className="page">
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault()
          setSubmittedQuery(query)
        }}
      >
        <input
          type="text"
          placeholder="Search Wallpaper Engine video wallpapers..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">Search</button>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as WorkshopSort)}
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
