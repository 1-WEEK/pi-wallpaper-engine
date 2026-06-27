# Pi Wallpaper Engine Context

## Product Goal
A Wallpaper Engine **Video** wallpaper player on a Raspberry Pi 4B. The web UI browses Steam Workshop, downloads video wallpapers, stores them in a declarative directory (`storage.root`), and controls mpv fullscreen loop playback.

## Architecture
- **Phase 1 (Active)**: Direct playback of original video files via `mpv` spawned by the backend over JSON IPC.
- **Phase 2 (Worker Transcoding)**: A NAS-side Docker worker pulls jobs from the Pi to transcode HEVC videos via Intel QSV, avoiding Pi CPU overload. The worker communicates via `PWE_WORKER_API_KEY` authenticated routes (`/api/transcode/*`). The `optimized/` output replaces the source file for playback automatically.
- **Storage**: Declarative custom directory (`storage.root`). Changes trigger a background rsync migration (`@pwe/migrate`). The SQLite DB remains local (`~/.local/state/pi-wallpaper-engine/`).
- **Auth**: Single-admin Better Auth + Passkey. Protects business APIs and WebSockets.
- **Player & Display**: `PlayerPower` controls `mpv` and display status linkage. `Rotation` interval-timer manages playlists (Sequential/Shuffle/Single).
- **Downloads**: Async SteamCMD wrapper using `box86`. Progress uses SQLite-backed `download_tasks`. Non-video items are rejected during finalization.

## Tech Stack
- Debian 13 Trixie (aarch64) on Raspberry Pi 4B
- Bun 1.2+ workspace monorepo
- Backend: Elysia + Effect-TS
- Frontend: Vite 8 + React + SWC (Plain CSS, no Tailwind)
- Transcode Worker: `ffmpeg` + Node.js (Dockerized)
