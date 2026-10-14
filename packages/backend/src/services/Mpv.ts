import { Context, Deferred, Effect, Fiber, Layer, PubSub, Ref, Semaphore, Stream } from "effect"
import { unlinkSync } from "node:fs"
import type { DisplayMode } from "@pwe/shared"
import { MpvIpcError } from "@pwe/shared"
import { Config } from "./Config.js"
import { Logger } from "./Logger.js"

export interface MpvProcess {
  readonly pid: number
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
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
  connect(path: string, handlers: MpvSocketHandlers, signal: AbortSignal): Promise<MpvSocket>
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
  /** Resolves after child exit and socket removal; failed cleanup can be retried. */
  readonly release: () => Effect.Effect<void, MpvIpcError>
  readonly setDisplayMode: (mode: DisplayMode) => Effect.Effect<void, MpvIpcError>
  readonly ended: () => Stream.Stream<void>
  readonly status: () => Effect.Effect<PlayerStatus>
}

// Coordinate mpv file-opening transitions with artifact validation and rename.
export const withPlaybackFileLock = Semaphore.makeUnsafe(1).withPermit

export class Mpv extends Context.Service<Mpv, MpvImpl>()("Mpv") {}

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

export const shouldConvergeToIdle = (msg: unknown): boolean => {
  if (typeof msg !== "object" || msg === null) return false
  const event = msg as Record<string, unknown>
  if (event.event !== "end-file") return false
  return event.reason !== "stop" && event.reason !== "quit"
}


const SOCKET_CONNECT_RETRIES = 30
const SOCKET_CONNECT_DELAY_MS = 200

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
})

const connectSocket = async (
  path: string,
  handlers: MpvSocketHandlers,
  signal: AbortSignal
): Promise<MpvSocket> => {
  let lastErr: unknown
  for (let i = 0; i < SOCKET_CONNECT_RETRIES; i++) {
    try {
      const socket = await Bun.connect({
        unix: path,
        socket: handlers,
      })
      if (signal.aborted) { socket.end(); throw signal.reason }
      return socket
    } catch (e) {
      lastErr = e
      signal.throwIfAborted()
      await sleep(SOCKET_CONNECT_DELAY_MS, signal)
    }
  }
  throw lastErr
}

const defaultDependencies: MpvDependencies = {
  spawn: (command, options) => Bun.spawn(command, options),
  connect: connectSocket,
  removeSocket: unlinkSync,
}

interface Session {
  readonly child: MpvProcess
  socket?: MpvSocket
  failure?: MpvIpcError
  cleanupError?: MpvIpcError
  possibleMedia?: { workshopId: string; path: string }
  exited: boolean
  readonly pending: Map<number, (result: Effect.Effect<unknown, MpvIpcError>) => void>
  buffer: string
}

export const makeMpvLive = (overrides: Partial<MpvDependencies> = {}) => Layer.effect(
  Mpv,
  Effect.gen(function* () {
    const deps = { ...defaultDependencies, ...overrides }
    const config = yield* Config
    const logger = yield* Logger
    const statusRef = yield* Ref.make<PlayerStatus>({
      playing: false, current_workshop_id: null, path: null,
      display_mode: config.screen.default_display_mode,
    })
    const endedPubSub = yield* PubSub.unbounded<void>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(endedPubSub))
    const lock = yield* Semaphore.make(1)
    const serialize = lock.withPermits(1)
    let active: Session | undefined
    let requestId = 0
    let closed = false
    const shutdown = yield* Deferred.make<void>()
    const control = <A>(effect: Effect.Effect<A, MpvIpcError>) => serialize(withPlaybackFileLock(Effect.suspend(() =>
      closed ? Effect.fail(new MpvIpcError({ reason: "mpv service closed" })) : effect.pipe(
        Effect.catch(error => active?.cleanupError === error ? Effect.fail(error) : releaseCurrent.pipe(
          Effect.mapError(cleanup => new MpvIpcError({
            reason: `${error.reason}; cleanup failed: ${cleanup.reason}`, cause: cleanup,
          })),
          Effect.andThen(Effect.fail(error)),
        )),
        Effect.onInterrupt(() => releaseCurrent.pipe(
          Effect.catch(e => logger.error(`mpv cancelled control cleanup failed: ${e.reason}`)),
        )),
      ),
    )))
    const scope = yield* Effect.scope
    let idleFiber: Fiber.Fiber<void, never> | undefined
    const cancelIdle = Effect.gen(function* () {
      const timer = idleFiber
      idleFiber = undefined
      if (timer) yield* Fiber.interrupt(timer)
    })

    const idleStatus = Ref.update(statusRef, s => ({
      ...s, playing: false, current_workshop_id: null, path: null,
    }))

    const failSession = (session: Session, error: MpvIpcError) => {
      session.failure ??= error
      const requests = [...session.pending.values()]
      session.pending.clear()
      session.buffer = ""
      for (const complete of requests) complete(Effect.fail(session.failure))
    }

    const removeSocket = Effect.try({
      try: () => {
        try { deps.removeSocket(config.mpv.ipc_socket) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause }
      },
      catch: cause => new MpvIpcError({ reason: "Failed to remove mpv IPC socket", cause }),
    })

    const releaseCurrent = Effect.gen(function* () {
      const session = active
      if (!session) return
      delete session.cleanupError
      failSession(session, new MpvIpcError({ reason: "mpv player released" }))
      yield* Effect.try({
        try: () => { session.socket?.end(); if (!session.exited) session.child.kill() },
        catch: cause => new MpvIpcError({ reason: "Failed to release mpv process", cause }),
      })
      const waitForExit = Effect.tryPromise({
        try: () => session.child.exited,
        catch: cause => new MpvIpcError({ reason: "Failed to await mpv process exit", cause }),
      })
      // Keep ownership uninterruptible, but let the deadline cancel each exit
      // waiter; an uninterruptible loser would make a timeout wait forever.
      const boundedExit = Effect.raceFirst(
        waitForExit.pipe(Effect.interruptible),
        Effect.sleep("1 second").pipe(
          Effect.andThen(Effect.fail(new MpvIpcError({ reason: "mpv process did not exit" }))),
          Effect.interruptible,
        ),
      )
      yield* boundedExit.pipe(Effect.catch(() => Effect.gen(function* () {
        yield* Effect.try({
          try: () => session.child.kill("SIGKILL"),
          catch: cause => new MpvIpcError({ reason: "Failed to kill mpv process", cause }),
        })
        yield* boundedExit
      })))
      session.exited = true
      yield* idleStatus
      yield* removeSocket
      if (active === session) active = undefined
    }).pipe(
      Effect.tapError(error => Effect.sync(() => {
        if (active) {
          active.cleanupError = error
          // An unacknowledged load may have reached mpv. Failed cleanup must
          // retain that media identity rather than advertise an unloaded player.
          if (active.possibleMedia && !active.exited) {
            const { workshopId, path } = active.possibleMedia
            Effect.runSync(Ref.update(statusRef, s => s.path ? s : {
              ...s, current_workshop_id: workshopId, path,
            }))
          }
        }
      })),
      Effect.uninterruptible,
    )

    const write = (session: Session, payload: string) => {
      if (!session.socket) throw new Error("mpv IPC socket unavailable")
      // Bun sockets are unbuffered; a partial JSON line poisons the next command.
      if (session.socket.write(payload) !== Buffer.byteLength(payload)) {
        failSession(session, new MpvIpcError({ reason: "Incomplete mpv command write" }))
        session.socket.end()
      }
    }

    const send = (session: Session, command: unknown[]): Effect.Effect<unknown, MpvIpcError> =>
      Effect.callback<unknown, MpvIpcError>(complete => {
        if (session.failure) { complete(Effect.fail(session.failure)); return }
        const id = ++requestId
        // Atomic registration/write leaves no dispatch queue for expired callers.
        session.pending.set(id, complete)
        try { write(session, JSON.stringify({ command, request_id: id }) + "\n") }
        catch (cause) {
          session.pending.delete(id)
          complete(Effect.fail(new MpvIpcError({
            reason: `Failed to write mpv command: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          })))
        }
        return Effect.sync(() => { session.pending.delete(id) })
      }).pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new MpvIpcError({ reason: `mpv command timed out: ${JSON.stringify(command)}` })),
      }), Effect.flatMap(value => session.failure ? Effect.fail(session.failure) : Effect.succeed(value)))

    const setMode = (session: Session, mode: DisplayMode) => Effect.gen(function* () {
      yield* send(session, ["set_property", "keepaspect", mode !== "stretch"])
      yield* send(session, ["set_property", "panscan", mode === "fill" ? 1.0 : 0.0])
    })

    const ensurePlayer = Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new MpvIpcError({ reason: "mpv service closed" }))
      if (active?.failure) yield* releaseCurrent
      if (active) return active
      yield* removeSocket
      // SSH launches lack compositor environment; explicit user settings still win.
      const uid = process.getuid?.() ?? 1000
      const child = yield* Effect.try({
        try: () => deps.spawn([
          config.mpv.binary_path,
          `--input-ipc-server=${config.mpv.ipc_socket}`,
          "--idle=yes", "--loop=inf", "--fullscreen", "--no-osc",
          "--no-input-default-bindings", "--no-audio",
          `--hwdec=${config.mpv.hwdec}`, `--gpu-api=${config.mpv.gpu_api}`,
          `--demuxer-max-bytes=${(config.mpv.cache_forward_mib ?? 32) * 1024 * 1024}`,
          `--demuxer-max-back-bytes=${(config.mpv.cache_backward_mib ?? 8) * 1024 * 1024}`,
          "--keepaspect=yes", "--panscan=1.0",
        ], {
          stdout: "pipe", stderr: "pipe", stdin: "ignore",
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "wayland-0",
          },
        }),
        catch: cause => new MpvIpcError({ reason: "Failed to spawn mpv", cause }),
      })
      const session: Session = { child, exited: false, pending: new Map(), buffer: "" }
      active = session
      void child.exited.then(
        code => {
          session.exited = true
          if (active === session) Effect.runSync(idleStatus)
          if (!session.failure) void Effect.runPromise(logger.warn(`mpv exited with status ${code}`))
          failSession(session, new MpvIpcError({ reason: `mpv process exited with status ${code}` }))
        },
        cause => failSession(session, new MpvIpcError({ reason: "mpv process exit observation failed", cause })),
      )
      const handlers: MpvSocketHandlers = {
        data(_socket, data) {
          if (session.failure || active !== session) return
          session.buffer += data.toString("utf-8")
          const lines = session.buffer.split("\n")
          session.buffer = lines.pop() ?? ""
          for (const line of lines) {
            try {
              const msg = JSON.parse(line)
              if (typeof msg.request_id === "number") {
                const complete = session.pending.get(msg.request_id)
                if (complete) {
                  session.pending.delete(msg.request_id)
                  complete(msg.error && msg.error !== "success"
                    ? Effect.fail(new MpvIpcError({ reason: `mpv error: ${msg.error}` }))
                    : Effect.succeed(msg.data ?? null))
                }
              } else if (shouldConvergeToIdle(msg)) {
                // The recovery consumer needs the held wallpaper identity and
                // the stopped verdict before it probes the media root.
                Effect.runSync(Ref.update(statusRef, s => ({ ...s, playing: false })))
                Effect.runSync(PubSub.publish(endedPubSub, undefined))
              } else if (shouldReassertFullscreen(msg)) {
                write(session, JSON.stringify({ command: ["set_property", "fullscreen", true] }) + "\n")
                void Effect.runPromise(logger.warn("mpv lost fullscreen; re-asserting"))
              }
            } catch { /* malformed events have no command caller */ }
          }
        },
        error(_socket, cause) { failSession(session, new MpvIpcError({ reason: `mpv IPC socket error: ${cause.message}`, cause })) },
        close() { failSession(session, new MpvIpcError({ reason: "mpv IPC socket closed" })) },
      }
      yield* Effect.tryPromise({
        try: signal => deps.connect(config.mpv.ipc_socket, handlers, signal).then(socket => {
          if (session.failure || signal.aborted) socket.end()
          else session.socket = socket
        }),
        catch: cause => new MpvIpcError({ reason: "mpv IPC socket not available", cause }),
      }).pipe(Effect.timeoutOrElse({
        duration: "6 seconds",
        orElse: () => Effect.fail(new MpvIpcError({ reason: "mpv IPC connection timed out" })),
      }), Effect.raceFirst(Deferred.await(shutdown).pipe(
        Effect.andThen(Effect.fail(new MpvIpcError({ reason: "mpv service closed" }))),
      )))
      yield* logger.info(`mpv spawned pid=${child.pid}, connected to ${config.mpv.ipc_socket}`)
      yield* send(session, ["observe_property", FULLSCREEN_OBSERVE_ID, "fullscreen"]).pipe(
        Effect.catch(e => logger.warn(`Could not observe mpv fullscreen: ${e.reason}`)),
      )
      yield* setMode(session, (yield* Ref.get(statusRef)).display_mode)
      return session
    })

    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      closed = true
      yield* Deferred.succeed(shutdown, undefined)
      yield* cancelIdle
      if (active) failSession(active, new MpvIpcError({ reason: "mpv service closed" }))
      yield* serialize(withPlaybackFileLock(releaseCurrent)).pipe(Effect.catch(e => logger.error(`mpv shutdown cleanup failed: ${e.reason}`)))
    }))

    return {
      play: (workshopId, path) => control(Effect.gen(function* () {
        yield* cancelIdle
        const session = yield* ensurePlayer
        session.possibleMedia = { workshopId, path }
        yield* send(session, ["loadfile", path, "replace"])
        yield* send(session, ["set_property", "pause", false])
        if (session.failure) return yield* Effect.fail(session.failure)
        yield* Ref.update(statusRef, s => ({ ...s, playing: true, current_workshop_id: workshopId, path }))
      })),
      pause: () => control(Effect.gen(function* () {
        if (!active) return
        if (active.failure) return yield* Effect.fail(active.failure)
        if (!(yield* Ref.get(statusRef)).path) return
        yield* send(active, ["set_property", "pause", true])
        yield* Ref.update(statusRef, s => ({ ...s, playing: false }))
      })),
      resume: () => control(Effect.gen(function* () {
        if (!active) return
        if (active.failure) return yield* Effect.fail(active.failure)
        if (!(yield* Ref.get(statusRef)).path) return
        yield* send(active, ["set_property", "pause", false])
        yield* Ref.update(statusRef, s => ({ ...s, playing: true }))
      })),
      stop: () => control(Effect.gen(function* () {
        if (active) {
          yield* send(active, ["stop"])
          delete active.possibleMedia
        }
        yield* idleStatus
        if (active) {
          yield* cancelIdle
          idleFiber = yield* Effect.forkIn(
            Effect.sleep("30 seconds").pipe(Effect.andThen(serialize(withPlaybackFileLock(releaseCurrent))),
              Effect.catch(e => logger.error(`mpv idle cleanup failed: ${e.reason}`))),
            scope,
          )
        }
      })),
      release: () => serialize(withPlaybackFileLock(cancelIdle.pipe(Effect.andThen(releaseCurrent)))),
      setDisplayMode: mode => control(Effect.gen(function* () {
        if (active) yield* setMode(active, mode)
        yield* Ref.update(statusRef, s => ({ ...s, display_mode: mode }))
      })),
      ended: () => Stream.fromPubSub(endedPubSub),
      status: () => Ref.get(statusRef),
    } satisfies MpvImpl
  })
)

export const MpvLive = makeMpvLive()
