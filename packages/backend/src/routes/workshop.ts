import { Elysia, t } from "elysia"
import { Effect } from "effect"
import { SteamWorkshop, type WorkshopSort } from "../services/SteamWorkshop.js"
import type { AppRuntime } from "../runtime.js"

const parseSort = (raw: string | undefined): WorkshopSort =>
  raw === "recent" ? "recent" : "trend"

const parseTags = (raw: string | undefined): string[] =>
  raw
    ? raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : []

export const workshopRoutes = (runtime: AppRuntime) =>
  new Elysia({ prefix: "/api/workshop" })
    .get(
      "/search",
      ({ query, set }) =>
        runtime
          .runPromise(
            Effect.gen(function* () {
              const ws = yield* SteamWorkshop
              return yield* ws.search({
                query: query.q ?? "",
                cursor: query.cursor ?? "*",
                pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 24,
                tags: parseTags(query.tags),
                sort: parseSort(query.sort),
              })
            }).pipe(
              Effect.catchTag("WorkshopApiError", (e) =>
                Effect.sync(() => {
                  set.status = e.status > 0 ? e.status : 502
                  return { error: e.message }
                })
              )
            )
          )
          .catch((e) => {
            set.status = 500
            return { error: e instanceof Error ? e.message : String(e) }
          }),
      {
        query: t.Object({
          q: t.Optional(t.String()),
          cursor: t.Optional(t.String()),
          pageSize: t.Optional(t.String()),
          tags: t.Optional(t.String()),
          sort: t.Optional(t.String()),
        }),
      }
    )
    .get("/item/:workshopId", ({ params, set }) =>
      runtime
        .runPromise(
          Effect.gen(function* () {
            const ws = yield* SteamWorkshop
            return yield* ws.getItem(params.workshopId)
          }).pipe(
            Effect.catchTag("WorkshopApiError", (e) =>
              Effect.sync(() => {
                set.status = e.status > 0 ? e.status : 502
                return { error: e.message }
              })
            )
          )
        )
        .catch((e) => {
          set.status = 500
          return { error: e instanceof Error ? e.message : String(e) }
        })
    )
