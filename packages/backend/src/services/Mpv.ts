import { Context, Effect, Layer, Ref } from "effect"
import { unlinkSync } from "node:fs"
import type { DisplayMode } from "@pwe/shared"
import { MpvIpcError, MpvSpawnError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"

export interface MpvProcess {
  readonly pid: number
  readonly exited: Promise<number>
  kill(): void
}

export interface MpvSocket {
  write(payload: string): number
  end(): void
}

export interface MpvSocketHandlers {
  data(socket: MpvSocket, data: Buffer): void
  error(socket: MpvSocket, error: Error): void
  close(socket: MpvSocket): void
}

export interface MpvDependencies {
  spawn(command: string[], options: {
    stdout: "pipe"; stderr: "pipe"; stdin: "ignore"
    env: Record<string, string | undefined>
  }): MpvProcess
  connect(path: string, handlers: MpvSocketHandlers): Promise<MpvSocket>
  removeSocket(path: string): void
}

export interface PlayerStatus {
  readonly playing: boolean
  readonly current_workshop_id: string | null
  readonly path: string | null
  readonly display_mode: DisplayMode
}

export interface MpvImpl {
  readonly play: (workshopId: string, path: string) => Effect.Effect<void, MpvIpcError>
  readonly pause: () => Effect.Effect<void, MpvIpcError>
  readonly resume: () => Effect.Effect<void, MpvIpcError>
  readonly stop: () => Effect.Effect<void, MpvIpcError>
  readonly setDisplayMode: (mode: DisplayMode) => Effect.Effect<void, MpvIpcError>
  readonly status: () => Effect.Effect<PlayerStatus>
}

export class Mpv extends Context.Tag("Mpv")<Mpv, MpvImpl>() {}

// The compositor owns the fullscreen state and may strip it at runtime
// (observed on labwc: after a display power cycle mpv can end up windowed
// with a titlebar, and --fullscreen alone never restores it). We observe the
// property and re-assert whenever mpv reports it flipped off.
export const FULLSCREEN_OBSERVE_ID = 1

export const shouldReassertFullscreen = (msg: unknown): boolean => {
  if (typeof msg !== "object" || msg === null) return false
  const event = msg as Record<string, unknown>
  return (
    event.event === "property-change" &&
    event.name === "fullscreen" &&
    event.data === false
  )
}

const SOCKET_CONNECT_RETRIES = 30
const SOCKET_CONNECT_DELAY_MS = 200

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const connectSocket = async (
  path: string,
  handlers: MpvSocketHandlers
): Promise<MpvSocket> => {
  let lastErr: unknown
  for (let i = 0; i < SOCKET_CONNECT_RETRIES; i++) {
    try {
      const socket = await Bun.connect({
        unix: path,
        socket: handlers,
      })
      return socket
    } catch (e) {
      lastErr = e
      await sleep(SOCKET_CONNECT_DELAY_MS)
    }
  }
  throw lastErr
}

const defaultDependencies: MpvDependencies = {
  spawn: (command, options) => Bun.spawn(command, options),
  connect: connectSocket,
  removeSocket: unlinkSync,
}

export const makeMpvLive = (overrides: Partial<MpvDependencies> = {}) => Layer.scoped(
  Mpv,
  Effect.gen(function* () {
    const deps = { ...defaultDependencies, ...overrides }
    const config = yield* Config
    const logger = yield* Logger

    // Clean up stale socket
    try {
      deps.removeSocket(config.mpv.ipc_socket)
    } catch {
      // ignore if doesn't exist
    }

    // Spawn mpv. Pi OS labwc runs on tty7 with a Wayland socket under
    // /run/user/<uid>/wayland-0. When backend is launched from an SSH session
    // (XDG_SESSION_TYPE=tty) it inherits no WAYLAND_DISPLAY, so mpv silently
    // falls back to SDL and the video decodes but never reaches the screen.
    // Fill in sane defaults so the inherited env still points at the local
    // compositor; user-set values win.
    const uid =
      typeof (process as { getuid?: () => number }).getuid === "function"
        ? (process as { getuid: () => number }).getuid()
        : 1000
    const mpvEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-0",
    }

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          deps.spawn(
            [
              config.mpv.binary_path,
              `--input-ipc-server=${config.mpv.ipc_socket}`,
              "--idle=yes",
              "--loop=inf",
              "--fullscreen",
              "--no-osc",
              "--no-input-default-bindings",
              "--no-audio",
              `--hwdec=${config.mpv.hwdec}`,
              `--gpu-api=${config.mpv.gpu_api}`,
              "--keepaspect=yes",
              "--panscan=1.0",
            ],
            { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: mpvEnv }
          ),
        catch: (cause) =>
          new MpvSpawnError({
            reason: `Failed to spawn mpv: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }) as Effect.Effect<MpvProcess, MpvSpawnError>,
      (proc) =>
        Effect.sync(() => {
          try {
            proc.kill()
          } catch {
            // ignore
          }
          try {
            deps.removeSocket(config.mpv.ipc_socket)
          } catch {
            // ignore
          }
        })
    )

    yield* logger.info(`mpv spawned pid=${child.pid}, connecting to ${config.mpv.ipc_socket}`)

    const pending = new Map<number, (result: Effect.Effect<unknown, MpvIpcError>) => void>()
    let requestId = 0
    let connectionFailure: MpvIpcError | undefined
    const failConnection = (error: MpvIpcError) => {
      connectionFailure ??= error
      const requests = [...pending.values()]
      pending.clear()
      for (const complete of requests) complete(Effect.fail(connectionFailure))
    }
    const statusRef = yield* Ref.make<PlayerStatus>({
      playing: false,
      current_workshop_id: null,
      path: null,
      display_mode: config.screen.default_display_mode,
    })

    let buffer = ""
    const handleData = (socket: MpvSocket, chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (typeof msg.request_id === "number") {
            const complete = pending.get(msg.request_id)
            if (complete) {
              pending.delete(msg.request_id)
              complete(msg.error && msg.error !== "success"
                ? Effect.fail(new MpvIpcError({ reason: `mpv error: ${msg.error}` }))
                : Effect.succeed(msg.data ?? null))
            }
          } else if (!connectionFailure && shouldReassertFullscreen(msg)) {
            const payload = JSON.stringify({ command: ["set_property", "fullscreen", true] }) + "\n"
            if (socket.write(payload) !== Buffer.byteLength(payload)) {
              failConnection(new MpvIpcError({ reason: "Incomplete mpv fullscreen recovery write" }))
              socket.end()
            }
            void Effect.runPromise(logger.warn("mpv lost fullscreen; re-asserting"))
          }
        } catch {
          // ignore malformed
        }
      }
    }

    const realSocket = yield* Effect.tryPromise({
      try: () =>
        deps.connect(config.mpv.ipc_socket, {
          data(s, data) {
            void handleData(s, data.toString("utf-8"))
          },
          error(_s, err) {
            failConnection(new MpvIpcError({ reason: `mpv IPC socket error: ${err.message}`, cause: err }))
            void Effect.runPromise(logger.error(`mpv IPC socket error: ${err.message}`))
          },
          close() {
            failConnection(new MpvIpcError({ reason: "mpv IPC socket closed" }))
            void Effect.runPromise(logger.warn("mpv IPC socket closed"))
          },
        }),
      catch: (cause) =>
        new MpvSpawnError({
          reason: `mpv IPC socket not available after ${(SOCKET_CONNECT_RETRIES * SOCKET_CONNECT_DELAY_MS) / 1000}s`,
          cause,
        }),
    })

    yield* Effect.addFinalizer(() => Effect.sync(() => {
      failConnection(new MpvIpcError({ reason: "mpv service closed" }))
      realSocket.end()
      buffer = ""
    }))

    const send = (cmd: unknown[]): Effect.Effect<unknown, MpvIpcError> =>
      Effect.async<unknown, MpvIpcError>((complete) => {
        if (connectionFailure) {
          complete(Effect.fail(connectionFailure))
          return
        }
        const id = ++requestId
        // Register and write in the same synchronous turn: interrupted callers
        // cannot leave a queued command to be dispatched after their deadline.
        pending.set(id, complete)
        try {
          const payload = JSON.stringify({ command: cmd, request_id: id }) + "\n"
          // Bun sockets are unbuffered; a partial JSON line poisons the next command.
          if (realSocket.write(payload) !== Buffer.byteLength(payload)) {
            failConnection(new MpvIpcError({ reason: "Incomplete mpv command write" }))
            realSocket.end()
          }
        } catch (cause) {
          pending.delete(id)
          complete(Effect.fail(new MpvIpcError({
            reason: `Failed to write mpv command: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          })))
        }
        return Effect.sync(() => { pending.delete(id) })
      }).pipe(Effect.timeoutFail({
        duration: "5 seconds",
        onTimeout: () => new MpvIpcError({ reason: `mpv command timed out: ${JSON.stringify(cmd)}` }),
      }))

    yield* send(["observe_property", FULLSCREEN_OBSERVE_ID, "fullscreen"]).pipe(
      Effect.catchAll((e) => logger.warn(`Could not observe mpv fullscreen: ${e.reason}`))
    )

    return {
      play: (workshopId, path) =>
        Effect.gen(function* () {
          yield* send(["loadfile", path, "replace"])
          yield* send(["set_property", "pause", false])
          yield* Ref.update(statusRef, (s) => ({
            ...s,
            playing: true,
            current_workshop_id: workshopId,
            path,
          }))
        }),

      pause: () =>
        Effect.gen(function* () {
          yield* send(["set_property", "pause", true])
          yield* Ref.update(statusRef, (s) => ({ ...s, playing: false }))
        }),

      resume: () =>
        Effect.gen(function* () {
          yield* send(["set_property", "pause", false])
          yield* Ref.update(statusRef, (s) => ({ ...s, playing: true }))
        }),

      stop: () =>
        Effect.gen(function* () {
          yield* send(["stop"])
          yield* Ref.update(statusRef, (s) => ({
            ...s,
            playing: false,
            current_workshop_id: null,
            path: null,
          }))
        }),

      setDisplayMode: (mode) =>
        Effect.gen(function* () {
          switch (mode) {
            case "fill":
              yield* send(["set_property", "keepaspect", true])
              yield* send(["set_property", "panscan", 1.0])
              break
            case "fit":
              yield* send(["set_property", "keepaspect", true])
              yield* send(["set_property", "panscan", 0.0])
              break
            case "stretch":
              yield* send(["set_property", "keepaspect", false])
              yield* send(["set_property", "panscan", 0.0])
              break
          }
          yield* Ref.update(statusRef, (s) => ({ ...s, display_mode: mode }))
        }),

      status: () => Ref.get(statusRef),
    }
  })
)

export const MpvLive = makeMpvLive()
