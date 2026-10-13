import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { ConfigLive } from "./Config.js"
import { Logger } from "./Logger.js"
import { Mpv, MpvLive } from "./Mpv.js"

const silentLogger = Layer.succeed(Logger, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
})

const withPlayer = async (
  budgets: Record<string, unknown>,
  check: (argv: string[], runtime: ManagedRuntime.ManagedRuntime<Mpv, unknown>) => Promise<void>,
) => {
  const dir = await mkdtemp(join(tmpdir(), "pwe-cache-"))
  const binary = join(dir, "mpv")
  const configPath = join(dir, "config.json")
  const argvPath = join(dir, "argv.json")
  // Exercise production spawn/connect with a small external mpv protocol peer.
  await writeFile(binary, `#!${process.execPath}
const args = process.argv.slice(2)
await Bun.write(${JSON.stringify(argvPath)}, JSON.stringify(args))
const socketPath = args.find(arg => arg.startsWith("--input-ipc-server=")).split("=")[1]
const buffers = new Map()
Bun.listen({ unix: socketPath, socket: {
  data(socket, data) {
    const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\\n")
    buffers.set(socket, lines.pop() ?? "")
    for (const line of lines) {
      const msg = JSON.parse(line)
      socket.write(JSON.stringify({ request_id: msg.request_id, error: "success" }) + "\\n")
    }
  },
  close(socket) { buffers.delete(socket) },
}})
`)
  await chmod(binary, 0o755)
  const template = await Bun.file(join(import.meta.dir, "../../../../config.example.json")).json()
  const config = {
    ...template,
    steam: { ...template.steam, username: "test", web_api_key: "test" },
    paths: { ...template.paths, data_root: dir },
    mpv: {
      binary_path: binary,
      ipc_socket: join(dir, "mpv.sock"),
      hwdec: "drmprime",
      gpu_api: "vulkan",
      ...budgets,
    },
  }
  await writeFile(configPath, JSON.stringify(config))
  const runtime = ManagedRuntime.make(MpvLive.pipe(
    Layer.provide(ConfigLive(configPath)),
    Layer.provide(silentLogger),
  ))
  try {
    await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.play("42", "/media/wallpaper.mp4")))
    await check(JSON.parse(await readFile(argvPath, "utf8")), runtime)
  } finally {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

describe("playback cache configuration at player creation", () => {
  test("each independently created player honors zero and the largest safe byte budget", async () => {
    for (let creation = 0; creation < 2; creation++) {
      await withPlayer({ cache_forward_mib: 0, cache_backward_mib: 8589934591 }, async argv => {
        expect(argv).toContain("--demuxer-max-bytes=0")
        expect(argv).toContain("--demuxer-max-back-bytes=9007199253692416")
      })
    }
  })

  test("administrator overrides restore the former 150/50 MiB cache budgets", async () => {
    await withPlayer({ cache_forward_mib: 150, cache_backward_mib: 50 }, async argv => {
      expect(argv).toContain("--demuxer-max-bytes=157286400")
      expect(argv).toContain("--demuxer-max-back-bytes=52428800")
    })
  })

  test("old configuration creates a player with 32/8 MiB budgets and preserves picture controls", async () => {
    await withPlayer({}, async (argv, runtime) => {
      expect(argv).toContain("--demuxer-max-bytes=33554432")
      expect(argv).toContain("--demuxer-max-back-bytes=8388608")
      expect(argv).toContain("--hwdec=drmprime")
      expect(argv).toContain("--gpu-api=vulkan")
      expect(argv).toContain("--fullscreen")
      expect(argv).toContain("--loop=inf")
      expect(argv).toContain("--keepaspect=yes")
      expect(argv).toContain("--panscan=1.0")
      await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.pause()))
      expect(await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.status()))).toMatchObject({
        playing: false, current_workshop_id: "42", path: "/media/wallpaper.mp4", display_mode: "fill",
      })
      await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.resume()))
      await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.setDisplayMode("fit")))
      expect(await runtime.runPromise(Effect.flatMap(Mpv, mpv => mpv.status()))).toMatchObject({
        playing: true, display_mode: "fit",
      })
    })
  })
})
