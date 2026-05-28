import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const backendPort = env.VITE_BACKEND_PORT ?? "8080"
  return {
    plugins: [react()],
    server: {
      host: true,
      // Vite 5 blocks unknown Host headers for DNS-rebinding protection. Leading
      // dot = subdomain wildcard, so this covers pi4.1week.home and any other
      // local-DNS .home hostnames on the LAN.
      allowedHosts: true,
      proxy: {
        "/api": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  }
})
