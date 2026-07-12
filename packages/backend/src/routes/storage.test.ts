import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Elysia } from "elysia"
import { homedir } from "node:os"
import type { MigrateImpl, MigrationProgress } from "../services/Migrate.js"
import { Migrate } from "../services/Migrate.js"
import {
  Storage,
  type StorageImpl,
  type StorageState,
} from "../services/Storage.js"
import {
  StorageRootSelection,
  type StorageLocation,
  type StorageRootSelectionImpl,
  type SwitchPlan,
  type ValidatedStorageRoot,
} from "../services/StorageRootSelection.js"
import { storageRoutes } from "./storage.js"

const homePrefix = homedir()

const baseStatus: StorageState = {
  available: true,
  data_root: `${homePrefix}/media/current`,
  default_root: `${homePrefix}/media/default`,
  using_default: false,
  last_error: null,
}

const baseMigration: MigrationProgress | null = null

const validatedTarget = (path: string): ValidatedStorageRoot => ({
  path,
  freeBytes: 40,
  totalBytes: 100,
  usedBytes: 60,
  isEmpty: false,
  hasSource: true,
  hasOptimized: false,
})

const makeSelection = (
  overrides: Partial<StorageRootSelectionImpl> = {}
): StorageRootSelectionImpl => ({
  listLocations: () =>
    Effect.succeed([
      { id: "home", label: "Home", path: `${homePrefix}/media/current` },
    ] satisfies ReadonlyArray<StorageLocation>),
  browseDirectories: (path) =>
    Effect.succeed({
      path,
      entries: [{ name: "Movies", path: `${path}/Movies` }],
    }),
  createDirectory: (parent, name) => Effect.succeed(`${parent}/${name.trim()}`),
  validateTarget: (path) => Effect.succeed(validatedTarget(path)),
  planSwitch: (path) =>
    Effect.succeed({
      action: "save",
      target: validatedTarget(path),
    } satisfies SwitchPlan),
  ...overrides,
})

const makeStorage = (status: StorageState = baseStatus) => {
  const saves: Array<string | null> = []
  const impl: StorageImpl = {
    status: () => Effect.succeed(status),
    mediaRoot: () => Effect.succeed(status.data_root),
    mediaRootOrNull: () => Effect.succeed(status.data_root),
    saveRoot: (root) =>
      Effect.sync(() => {
        saves.push(root)
        return status
      }),
  }
  return { impl, saves }
}

const makeMigrate = (migration: MigrationProgress | null = baseMigration) => {
  const starts: string[] = []
  const impl: MigrateImpl = {
    start: (targetRoot) =>
      Effect.sync(() => {
        starts.push(targetRoot)
        return migration ?? { state: "running", moved_bytes: 0, total_bytes: 0, error: null }
      }),
    status: () => Effect.succeed(migration),
    cancel: () => Effect.succeed(migration),
    isRunning: () => Effect.succeed(migration?.state === "running"),
  }
  return { impl, starts }
}

const buildApp = (
  selection: StorageRootSelectionImpl,
  opts: { status?: StorageState; migration?: MigrationProgress | null } = {}
) => {
  const storage = makeStorage(opts.status ?? baseStatus)
  const migrate = makeMigrate(opts.migration ?? baseMigration)
  const runtime = ManagedRuntime.make(
    Layer.succeed(StorageRootSelection, selection).pipe(
      Layer.provideMerge(Layer.succeed(Storage, storage.impl)),
      Layer.provideMerge(Layer.succeed(Migrate, migrate.impl))
    )
  )
  const app = new Elysia().use(storageRoutes(runtime as never))
  return { app, runtime, storage, migrate }
}

let runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = []

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes = []
})

describe("storage routes", () => {
  test("GET /locations preserves the existing display-path shape", async () => {
    const { app, runtime } = buildApp(makeSelection())
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(new Request("http://localhost/api/storage/locations"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        id: "home",
        label: "Home",
        path: `${homePrefix}/media/current`,
        display_path: "~/media/current",
      },
    ])
  })

  test("GET /directories preserves the path, display_path, and entries contract", async () => {
    const { app, runtime } = buildApp(
      makeSelection({
        browseDirectories: () =>
          Effect.succeed({
            path: `${homePrefix}/media/current`,
            entries: [
              { name: "Movies", path: `${homePrefix}/media/current/Movies` },
              { name: "Shows", path: `${homePrefix}/media/current/Shows` },
            ],
          }),
      })
    )
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request(
        `http://localhost/api/storage/directories?path=${encodeURIComponent(`${homePrefix}/media/current`)}`
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: `${homePrefix}/media/current`,
      display_path: "~/media/current",
      entries: [
        { name: "Movies", path: `${homePrefix}/media/current/Movies` },
        { name: "Shows", path: `${homePrefix}/media/current/Shows` },
      ],
    })
  })

  test("POST /directories preserves the created path contract", async () => {
    const { app, runtime } = buildApp(makeSelection())
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/storage/directories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: `${homePrefix}/media/current`, name: "Movies" }),
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: `${homePrefix}/media/current/Movies`,
      display_path: "~/media/current/Movies",
    })
  })

  test("POST /validate-target preserves the existing snake_case success body", async () => {
    const { app, runtime } = buildApp(makeSelection())
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/storage/validate-target", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_root: `${homePrefix}/media/target` }),
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      path: `${homePrefix}/media/target`,
      display_path: "~/media/target",
      free_bytes: 40,
      total_bytes: 100,
      used_bytes: 60,
      is_empty: false,
      has_source: true,
      has_optimized: false,
      message: "Directory is available and ready.",
    })
  })

  test("POST /root executes a save plan and keeps the 200 contract", async () => {
    const { app, runtime, storage, migrate } = buildApp(
      makeSelection({
        planSwitch: (path) =>
          Effect.succeed({
            action: "save",
            target: validatedTarget(path),
          } satisfies SwitchPlan),
      })
    )
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/storage/root", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_root: `${homePrefix}/media/target` }),
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...baseStatus, migration: null })
    expect(storage.saves).toEqual([`${homePrefix}/media/target`])
    expect(migrate.starts).toEqual([])
  })

  test("POST /root executes a migrate plan and keeps the 202 contract", async () => {
    const { app, runtime, storage, migrate } = buildApp(
      makeSelection({
        planSwitch: (path) =>
          Effect.succeed({
            action: "migrate",
            target: validatedTarget(path),
          } satisfies SwitchPlan),
      }),
      { migration: { state: "running", moved_bytes: 10, total_bytes: 20, error: null } }
    )
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>)

    const res = await app.handle(
      new Request("http://localhost/api/storage/root", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_root: `${homePrefix}/media/target` }),
      })
    )

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({
      ...baseStatus,
      migration: { state: "running", moved_bytes: 10, total_bytes: 20, error: null },
    })
    expect(storage.saves).toEqual([])
    expect(migrate.starts).toEqual([`${homePrefix}/media/target`])
  })
})
