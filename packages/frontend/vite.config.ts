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
      rollupOptions: {
        output: {
          // Split node_modules into a vendor chunk so the app chunk stays small
          // and the vendor bundle caches across app-only changes. Build-time
          // split, so no runtime Suspense/loading flash.
          manualChunks: (id: string) => (id.includes("node_modules") ? "vendor" : undefined),
        },
      },
    },
  }
})
