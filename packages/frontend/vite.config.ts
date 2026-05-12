import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Vite 5 blocks unknown Host headers for DNS-rebinding protection. Leading
    // dot = subdomain wildcard, so this covers pi4.1week.home and any other
    // local-DNS .home hostnames on the LAN.
    allowedHosts: [".home", ".local"],
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
