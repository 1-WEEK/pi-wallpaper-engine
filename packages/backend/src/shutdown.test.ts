import { expect, test } from "bun:test"
import { stopServer } from "./shutdown.js"

test("stopServer closes active WebSocket connections", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message() {},
    },
  })
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
        once: true,
      })
    })

    const result = await Promise.race([
      stopServer(server).then(() => "stopped" as const),
      Bun.sleep(500).then(() => "timeout" as const),
    ])

    expect(result).toBe("stopped")
  } finally {
    socket.close()
    server.stop(true)
  }
})
