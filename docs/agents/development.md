# Development Guide

## Workspace Map

| Package | Responsibility |
| --- | --- |
| `@pwe/shared` | Effect schemas, tagged errors, cross-package types |
| `@pwe/backend` | Bun, Elysia, Effect services, SQLite, mpv ownership |
| `@pwe/frontend` | Vite, React, plain CSS, browser API client |
| `@pwe/migrate` | rsync copy, verification, and removal helpers |
| `@pwe/worker` | Bun and ffmpeg in a NAS Docker container |

The root and package `package.json` files own dependency versions and commands.

## Validation

Run commands from the repository root unless a command says otherwise.

| Change or check | Command |
| --- | --- |
| Unit and service tests | `bun test` |
| Focused regression test | `bun test packages/backend/src/transcode/decide.test.ts` (substitute the affected file) |
| All workspace types | `bun run typecheck` |
| Production frontend build | `bun run build` |
| Browser workflows | `bun run test:e2e` |
| Pi dependencies, Steam login, display and decode diagnostics | `bun run check` |
| Documentation only | Check links, named paths and scripts, then `git diff --check` |

[CI](../../.github/workflows/ci.yml) runs tests, typechecking, the frontend build,
and a separate Worker image build/smoke test. [E2E](../../.github/workflows/e2e.yml)
runs the browser suite separately. These checks cover software behavior; Pi
playback and NAS acceleration still need hardware evidence when those are affected.
Report which checks ran and any remaining hardware validation.

Browser tests live in `packages/frontend/e2e/*.pw.ts`. Playwright starts the Vite
frontend and mocks `/api/*`, so this suite needs neither the backend nor Pi hardware.
Use the existing `fixtures.ts` and `helpers.ts`; follow
[playwright.config.ts](../../playwright.config.ts) for server and browser settings.
If Chromium is missing, install it with `bunx playwright install chromium`.

## Local Servers and Configuration

```bash
bun run dev
bun run dev:backend
bun run dev:frontend
```

The first command starts both servers; the others start one. Default ports are
5173 for Vite and 8080 for the backend. Vite binds to the LAN and proxies `/api`
and WebSockets to the backend. `VITE_BACKEND_PORT` selects a different proxy target;
see [vite.config.ts](../../packages/frontend/vite.config.ts) and [dev.sh](../../dev.sh).
Production serves `packages/frontend/dist/` from the backend.

The default runtime config is `~/.config/pi-wallpaper-engine/config.json`;
`PWE_CONFIG` overrides it. It contains credentials. Use
[config.example.json](../../config.example.json) and
[Config schema](../../packages/shared/src/schema/Config.ts) when changing fields.
The schema validates config at startup. For media-root and SQLite behavior, read
[Storage and Migration](backend.md#storage-and-migration).

## Pi Runtime

```bash
bash install-pi.sh
bash install-pi.sh --service
```

The default installer prepares dependencies, config, frontend assets, and
diagnostics. `--service` also installs and enables the systemd user service.

- SteamCMD uses box86 and Valve's tarball on Trixie aarch64. The installer sets up
  armhf support, installs box86, extracts SteamCMD to `~/.local/share/steamcmd/`,
  and installs `/usr/local/bin/steamcmd`. Retain this path instead of switching to
  Debian's incompatible `steamcmd:i386` package.
- SteamCMD login state is in `~/Steam/config/config.vdf` under `Accounts`.
  `loginusers.vdf` belongs to the Steam client. Keep installer and preflight
  checks aligned with SteamCMD's config location.
- The Pi 4B defaults are `--hwdec=auto --gpu-api=opengl`, configurable through
  `mpv.hwdec` and `mpv.gpu_api`.

## Service Deployment

After building changed frontend assets, use the guarded restart command:

```bash
bun run service:restart
```

[restart-prod.ts](../../scripts/restart-prod.ts) checks for a dirty tree, snapshots
the business database with SQLite `VACUUM INTO`, restarts the service, and probes
health. `bun run service:restart -- --force` intentionally bypasses the dirty-tree
guard. The script currently assumes the default state directory and port 8080;
check those assumptions before relying on it with custom settings.

```bash
bun run service:start
bun run service:stop
bun run service:status
journalctl --user -u pi-wallpaper-engine -f
```

Start/stop/status are plain systemctl wrappers. The backend owns mpv, so a restart
causes a brief playback interruption. For removal, read [Uninstall](../uninstall.md).

## Frontend

- Keep the existing plain CSS system. Reuse tokens from
  [styles.css](../../packages/frontend/src/styles.css); colors belong in CSS
  custom properties, not component literals. Reuse controls and icons from
  [icons.tsx](../../packages/frontend/src/icons.tsx).
- Keep mobile and desktop workflows consistent with the existing shell. Verify
  layout and interactions at both sizes using the browser suite and screenshots
  appropriate to the change.
- Logo assets are [favicon.svg](../../packages/frontend/public/favicon.svg) and
  [favicon.ico](../../packages/frontend/public/favicon.ico). Regenerate the ICO
  from the SVG using `@resvg/resvg-js` in a temporary tooling directory
  (SVG to PNG to ICO), retaining 16/32/48px sizes. This avoids depending on a
  system `rsvg-convert` installation.
