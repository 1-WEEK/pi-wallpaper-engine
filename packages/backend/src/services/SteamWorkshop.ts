import { Context, Effect, Layer, Schema } from "effect"
import {
  GetPublishedFileDetailsResponse,
  QueryFilesResponse,
  WorkshopApiError,
  type WorkshopItem,
} from "@pwe/shared"
import { Config } from "./Config.js"

const WE_APPID = 431960

export type WorkshopSort = "trend" | "recent"

export interface WorkshopSearchParams {
  readonly query: string
  readonly cursor?: string
  readonly pageSize?: number
  readonly tags?: ReadonlyArray<string>
  readonly sort?: WorkshopSort
}

export interface WorkshopSearchResult {
  readonly total: number
  readonly items: ReadonlyArray<WorkshopItem>
}

export interface SteamWorkshopImpl {
  readonly search: (
    params: WorkshopSearchParams
  ) => Effect.Effect<WorkshopSearchResult, WorkshopApiError>
  readonly getItem: (workshopId: string) => Effect.Effect<WorkshopItem, WorkshopApiError>
}

export class SteamWorkshop extends Context.Tag("SteamWorkshop")<
  SteamWorkshop,
  SteamWorkshopImpl
>() {}

const decodeQuery = Schema.decodeUnknown(QueryFilesResponse)
const decodeDetails = Schema.decodeUnknown(GetPublishedFileDetailsResponse)

const fetchJson = (url: string): Effect.Effect<unknown, WorkshopApiError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, { headers: { Accept: "application/json" } })
      if (!res.ok) {
        throw new WorkshopApiError({
          status: res.status,
          message: `${res.status} ${res.statusText}`,
        })
      }
      return res.json()
    },
    catch: (e) =>
      e instanceof WorkshopApiError
        ? e
        : new WorkshopApiError({
            status: 0,
            message: `Network: ${e instanceof Error ? e.message : String(e)}`,
          }),
  })

// Steam IPublishedFileService query_type — only 2 modes wired up here.
// See https://partner.steamgames.com/doc/webapi/IPublishedFileService
const QUERY_TYPE = {
  trend: 9, // ranked by trend (popular)
  recent: 1, // most recent
} as const

// 30-min TTL is well under the practical churn rate of "trend" / "recent" lists
// for a niche tag (WE Video). Multi-client cache hit rate matters more than
// freshness for this app — re-search the same chip set within half an hour
// shouldn't re-hit Steam.
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX_ENTRIES = 200

interface CacheEntry {
  readonly value: WorkshopSearchResult
  readonly expiresAt: number
}

export const SteamWorkshopLive = Layer.effect(
  SteamWorkshop,
  Effect.gen(function* () {
    const config = yield* Config
    const apiKey = config.steam.web_api_key

    // Map preserves insertion order — used as a poor-man's LRU. Re-set on hit
    // bumps an entry to most-recent; size cap evicts the oldest key.
    const cache = new Map<string, CacheEntry>()

    const cacheKey = (p: Required<Omit<WorkshopSearchParams, "tags">> & { tags: string[] }) =>
      JSON.stringify(p)

    const cacheGet = (key: string): WorkshopSearchResult | null => {
      const hit = cache.get(key)
      if (!hit) return null
      if (hit.expiresAt < Date.now()) {
        cache.delete(key)
        return null
      }
      cache.delete(key)
      cache.set(key, hit)
      return hit.value
    }

    const cachePut = (key: string, value: WorkshopSearchResult) => {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      if (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    }

    const buildQueryUrl = (
      query: string,
      cursor: string,
      pageSize: number,
      tags: ReadonlyArray<string>,
      sort: WorkshopSort
    ): string => {
      const u = new URL("https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/")
      u.searchParams.set("key", apiKey)
      u.searchParams.set("query_type", String(QUERY_TYPE[sort]))
      u.searchParams.set("cursor", cursor)
      u.searchParams.set("numperpage", String(pageSize))
      u.searchParams.set("creator_appid", String(WE_APPID))
      u.searchParams.set("appid", String(WE_APPID))
      u.searchParams.set("filetype", "0")
      u.searchParams.set("return_short_description", "true")
      u.searchParams.set("return_previews", "true")
      u.searchParams.set("return_tags", "true")
      u.searchParams.set("match_all_tags", "true")
      // WE Type tag is mandatory; user-supplied tags AND together with it.
      const requiredTags = ["Video", ...tags.filter((t) => t !== "Video")]
      requiredTags.forEach((t, i) => u.searchParams.set(`requiredtags[${i}]`, t))
      if (query.trim().length > 0) u.searchParams.set("search_text", query.trim())
      return u.toString()
    }

    return {
      search: ({ query, cursor = "*", pageSize = 24, tags = [], sort = "trend" }) =>
        Effect.gen(function* () {
          const normTags = [...tags].sort()
          const key = cacheKey({ query, cursor, pageSize, tags: normTags, sort })
          const cached = cacheGet(key)
          if (cached) return cached
          const raw = yield* fetchJson(
            buildQueryUrl(query, cursor, pageSize, normTags, sort)
          )
          const decoded = yield* decodeQuery(raw).pipe(
            Effect.mapError(
              (e) => new WorkshopApiError({ status: 0, message: `Schema: ${e.message}` })
            )
          )
          const result: WorkshopSearchResult = {
            total: decoded.response.total,
            items: decoded.response.publishedfiledetails ?? [],
          }
          cachePut(key, result)
          return result
        }),

      getItem: (workshopId) =>
        Effect.gen(function* () {
          const u = new URL(
            "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
          )
          const body = new URLSearchParams()
          body.set("itemcount", "1")
          body.set("publishedfileids[0]", workshopId)
          const raw = yield* Effect.tryPromise({
            try: async () => {
              const res = await fetch(u.toString(), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString(),
              })
              if (!res.ok) {
                throw new WorkshopApiError({
                  status: res.status,
                  message: `${res.status} ${res.statusText}`,
                })
              }
              return res.json()
            },
            catch: (e) =>
              e instanceof WorkshopApiError
                ? e
                : new WorkshopApiError({
                    status: 0,
                    message: `Network: ${e instanceof Error ? e.message : String(e)}`,
                  }),
          })
          const decoded = yield* decodeDetails(raw).pipe(
            Effect.mapError(
              (e) => new WorkshopApiError({ status: 0, message: `Schema: ${e.message}` })
            )
          )
          const item = decoded.response.publishedfiledetails[0]
          if (!item)
            return yield* Effect.fail(
              new WorkshopApiError({ status: 404, message: "Item not found" })
            )
          return item
        }),
    }
  })
)
