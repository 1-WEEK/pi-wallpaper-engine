import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer, ManagedRuntime } from "effect"
import exampleConfig from "../../../../config.example.json"
import { Config, type RuntimeConfig } from "./Config.js"
import { Logger } from "./Logger.js"
import { makeMpvLive, Mpv } from "./Mpv.js"

test("real child/socket ownership is resolved on release, reconnection, and final shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwe-lifetime-"))
  const binary = join(directory, "mpv")
  const socketPath = join(directory, "mpv.sock")
  await writeFile(binary, `#!${process.execPath}
const path = process.argv.find(arg => arg.startsWith("--input-ipc-server=")).split("=")[1]
const buffers = new Map()
Bun.listen({ unix: path, socket: {
  data(socket, data) {
    const lines = ((buffers.get(socket) ?? "") + data.toString()).split("\\n")
    buffers.set(socket, lines.pop() ?? "")
    for (const line of lines) {
      const message = JSON.parse(line)
      socket.write(JSON.stringify({ request_id: message.request_id, error: "success" }) + "\\n")
    }
  },
  close(socket) { buffers.delete(socket) },
}})
`)
  await chmod(binary, 0o755)
  const children: ReturnType<typeof Bun.spawn>[] = []
  const runtime = ManagedRuntime.make(makeMpvLive({
    spawn(command, options) {
      const child = Bun.spawn(command, options)
      children.push(child)
      return child
    },
  }).pipe(
    Layer.provide(Layer.succeed(Config, {
      ...exampleConfig, mpv: { ...exampleConfig.mpv, binary_path: binary, ipc_socket: socketPath },
    } as RuntimeConfig)),
    Layer.provide(Layer.succeed(Logger, {
      info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void, debug: () => Effect.void,
    })),
  ))
  try {
    const mpv = await runtime.runPromise(Mpv)
    expect(children).toHaveLength(0)
    await runtime.runPromise(mpv.play("a", "/a.mp4"))
    expect(existsSync(socketPath)).toBe(true)
    await runtime.runPromise(mpv.release())
    expect(() => process.kill(children[0]!.pid, 0)).toThrow()
    expect(existsSync(socketPath)).toBe(false)
    await runtime.runPromise(mpv.play("b", "/b.mp4"))
    expect(children).toHaveLength(2)
    expect(children[1]!.pid).not.toBe(children[0]!.pid)
    expect(existsSync(socketPath)).toBe(true)
    await runtime.dispose()
    expect(() => process.kill(children[1]!.pid, 0)).toThrow()
    expect(existsSync(socketPath)).toBe(false)
  } finally {
    await runtime.dispose()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited }
    }
    await rm(directory, { recursive: true, force: true })
  }
})
