import { Context, Deferred, Effect, Layer, Queue, Ref } from "effect"
import { unlinkSync } from "node:fs"
import type { DisplayMode } from "@pwe/shared"
import { MpvIpcError, MpvSpawnError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"

type Subprocess = ReturnType<typeof Bun.spawn>
type UnixSocket = ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never

interface PendingCommand {
  readonly id: number
  readonly cmd: unknown[]
  readonly deferred: Deferred.Deferred<unknown, MpvIpcError>
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

const SOCKET_CONNECT_RETRIES = 30
const SOCKET_CONNECT_DELAY_MS = 200

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const connectSocket = async (path: string): Promise<UnixSocket> => {
  let lastErr: unknown
  for (let i = 0; i < SOCKET_CONNECT_RETRIES; i++) {
    try {
      const socket = await Bun.connect({
        unix: path,
        socket: {
          data() {},
          error() {},
          close() {},
        },
      })
      return socket
    } catch (e) {
      lastErr = e
      await sleep(SOCKET_CONNECT_DELAY_MS)
    }
  }
  throw lastErr
}

export const MpvLive = Layer.scoped(
  Mpv,
  Effect.gen(function* () {
    const config = yield* Config
    const logger = yield* Logger

    // Clean up stale socket
    try {
      unlinkSync(config.mpv.ipc_socket)
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
          Bun.spawn(
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
      }) as Effect.Effect<Subprocess, MpvSpawnError>,
      (proc) =>
        Effect.sync(() => {
          try {
            proc.kill()
          } catch {
            // ignore
          }
          try {
            unlinkSync(config.mpv.ipc_socket)
          } catch {
            // ignore
          }
        })
    )

    yield* logger.info(`mpv spawned pid=${child.pid}, connecting to ${config.mpv.ipc_socket}`)

    // Connect to IPC socket
    const socket = yield* Effect.tryPromise({
      try: () => connectSocket(config.mpv.ipc_socket),
      catch: (cause) =>
        new MpvSpawnError({
          reason: `mpv IPC socket not available after ${(SOCKET_CONNECT_RETRIES * SOCKET_CONNECT_DELAY_MS) / 1000}s`,
          cause,
        }),
    })

    const pendingRef = yield* Ref.make<Map<number, PendingCommand>>(new Map())
    const requestIdRef = yield* Ref.make(0)
    const statusRef = yield* Ref.make<PlayerStatus>({
      playing: false,
      current_workshop_id: null,
      path: null,
      display_mode: config.screen.default_display_mode,
    })

    // Replace the no-op data handler by re-creating the connection with a real handler
    // is awkward; instead, attach event-style handling via socket events at the Bun level.
    // For Bun unix sockets we get data() called inside the socket options. Re-bind here:
    let buffer = ""
    const handleData = async (chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (typeof msg.request_id === "number") {
            const pending = (await Effect.runPromise(Ref.get(pendingRef))).get(msg.request_id)
            if (pending) {
              await Effect.runPromise(
                Ref.update(pendingRef, (m) => {
                  const next = new Map(m)
                  next.delete(msg.request_id)
                  return next
                })
              )
              if (msg.error && msg.error !== "success") {
                await Effect.runPromise(
                  Deferred.fail(
                    pending.deferred,
                    new MpvIpcError({ reason: `mpv error: ${msg.error}` })
                  )
                )
              } else {
                await Effect.runPromise(Deferred.succeed(pending.deferred, msg.data ?? null))
              }
            }
          }
        } catch {
          // ignore malformed
        }
      }
    }

    // Bun unix sockets don't expose `.on('data')` directly the same way; we used
    // the `socket` config which is bound at connect time. As a workaround we
    // patch the data handler by reading from the underlying connection. For mpv
    // we instead pipe its stdout for line-based parsing — but mpv writes its
    // command responses only over the IPC socket, not stdout.
    //
    // Bun's connect API: pass a socket handler at connect time. We need to
    // refactor: connect with a real data handler that closes over our state.
    // Cleaner — re-connect with handler now that state is set up.

    socket.end()

    const realSocket = yield* Effect.tryPromise({
      try: () =>
        Bun.connect({
          unix: config.mpv.ipc_socket,
          socket: {
            data(_s, data) {
              void handleData(data.toString("utf-8"))
            },
            error(_s, err) {
              void Effect.runPromise(logger.error(`mpv IPC socket error: ${err.message}`))
            },
            close() {
              void Effect.runPromise(logger.warn("mpv IPC socket closed"))
            },
          },
        }),
      catch: (cause) =>
        new MpvSpawnError({
          reason: "Failed to re-connect mpv IPC socket with handler",
          cause,
        }),
    })

    // Outgoing command queue ensures one-in-flight ordering for callers, even
    // though the IPC protocol multiplexes by request_id.
    const cmdQueue = yield* Queue.unbounded<PendingCommand>()

    const dispatcher = Effect.forever(
      Effect.gen(function* () {
        const pending = yield* Queue.take(cmdQueue)
        yield* Ref.update(pendingRef, (m) => {
          const next = new Map(m)
          next.set(pending.id, pending)
          return next
        })
        const payload = JSON.stringify({ command: pending.cmd, request_id: pending.id }) + "\n"
        yield* Effect.try({
          try: () => realSocket.write(payload),
          catch: (cause) =>
            new MpvIpcError({
              reason: `Failed to write mpv command: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        }).pipe(
          Effect.tapError((err) => Deferred.fail(pending.deferred, err)),
          Effect.ignore
        )
      })
    )

    yield* Effect.forkScoped(dispatcher)

    const send = (cmd: unknown[]): Effect.Effect<unknown, MpvIpcError> =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(requestIdRef, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, MpvIpcError>()
        yield* Queue.offer(cmdQueue, { id, cmd, deferred })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () =>
              new MpvIpcError({ reason: `mpv command timed out: ${JSON.stringify(cmd)}` }),
          })
        )
      })

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
