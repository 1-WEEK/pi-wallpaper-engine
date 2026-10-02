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
| Media-root outage/recovery behavior (real mpv, isolated namespace) | `bash scripts/smoke-media-root-recovery.sh` |
| Boot behavior with the media root absent (drives the installed unit) | `bash scripts/check-boot-recovery.sh` |
| systemd unit mount ordering | `bash scripts/check-service-unit.sh` |
| Documentation only | Check links, named paths and scripts, then `git diff --check` |

There is no hosted CI. Run the commands above locally and report which ones ran;
Worker image changes keep their own local gate:
`bash scripts/smoke-test-worker-image.sh <tag>` after a local build. These checks
cover software behavior; Pi playback and NAS acceleration still need hardware
evidence when those are affected. Report any remaining hardware validation.

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

### Media-root ordering

The media root is usually a network mount, and the service must not race it at
boot. `install-pi.sh --service` renders the unit through
[render-service-unit.sh](../../scripts/render-service-unit.sh), which reads the
media root from configuration (`storage.root` when set, otherwise
`paths.data_root`) and orders the service after that path's mount unit with
`After=` + `Wants=`. `systemd-escape` produces the unit name, so a deployment at
`/srv/media` gets `srv-media.mount` and nothing is hardcoded to one share.
Re-running the installer rewrites the unit in place, replacing any older
ordering.

It is deliberately **not** `RequiresMountsFor=`. That directive is shorthand for
`Requires=` + `After=`, so a failed mount unit would take the service down with
it — and the web UI is the only place an administrator can see and fix "the
share is not mounted", so failing it is strictly worse than starting without the
share.

**Scope limitation (measured 2026-10-01).** This service is a *user* unit, and
the shelf-generated mounts are *system* units. The user manager cannot resolve a
system unit name: `systemctl --user show systemd-journald.service` reports
`LoadState=not-found`, and for the mount unit itself the user manager reports
`FragmentPath=` with `SourcePath=/proc/self/mountinfo` — it mirrors a filesystem
that is *already* mounted, and has no unit file to start. So the emitted
`After=`/`Wants=` orders nothing while the share is still down, which is exactly
the boot window it was meant to cover; the name is unresolvable and the
dependency is inert. The directive is retained because it is correct and becomes
effective whenever the mount resolves in the same manager (a user-scope mount, or
if this service is ever converted to a system unit), and it is harmless
otherwise.

What actually delivers the outcome — a normal boot ends with the wallpaper
playing — is the runtime recovery, which handles a mount that arrives at any
point: the startup restore fails against the absent share, and the media-root
watch resumes the wallpaper as soon as the path answers. See
[Playback and Display](backend.md#playback-and-display). Cross-manager ordering
would only shorten the gap; it cannot be the guarantee.

Verify the rendering without installing:

```bash
bash scripts/check-service-unit.sh
```

Record the boot behavior itself (drives the installed unit with an isolated
config and state, then restores the live deployment):

```bash
bash scripts/check-boot-recovery.sh
```

## Frontend

- The redesign foundation (implementation ticket 01) lives in
  [tokens.css](../../packages/frontend/src/tokens.css) (`--pt-*` colors,
  `--pf-*` font layers, motion tokens, thin scrollbar, `pt-enter`
  choreography), [railShell.css](../../packages/frontend/src/railShell.css),
  and [RailShell.tsx](../../packages/frontend/src/components/RailShell.tsx).
  New-design components consume only `--pt-*` variables; legacy pages keep
  the older `--ink`/`--paper`/`--accent` tokens until their own tickets.
  Theme state is owned by [theme.ts](../../packages/frontend/src/theme.ts)
  (`<html data-theme>`, localStorage `pwe-theme`, inline boot script in
  index.html); reduced-motion gates live in
  [reducedMotion.ts](../../packages/frontend/src/reducedMotion.ts), with
  shared VT/ghost/lenis helpers in `viewTransition.ts` / `ghost.ts` /
  `useLenis.ts`. New styles must use the `--ease-*`/`--dur-*` tokens, never
  bare `ease`/`ease-in`/`ease-out` keywords.
- The redesigned Browse page (implementation ticket 02) lives in
  [browse.css](../../packages/frontend/src/browse.css) (`.bws-*` classes):
  desktop renders the measured coordinate grid
  ([GridOverlay.tsx](../../packages/frontend/src/components/GridOverlay.tsx),
  offset geometry only), the contact-sheet card
  ([ContactCard.tsx](../../packages/frontend/src/components/ContactCard.tsx)),
  and the shared three-state block
  ([StateBlock.tsx](../../packages/frontend/src/components/StateBlock.tsx)).
  The mobile branch keeps the legacy `.page`/`.wallpaper-card` layout.
- The keyboard focus band (implementation ticket 06) is the reusable
  [FocusRing.tsx](../../packages/frontend/src/components/FocusRing.tsx) +
  [focusRing.css](../../packages/frontend/src/focusRing.css): one shared
  element parked on the cursor item via pure offset geometry, FLIP slide
  (250ms `--ease-slide`, re-trigger from the presented value), instant
  ResizeObserver snap on reflow, and the Enter confirm beat (dither band
  out / XOR `difference` block in, ~120ms). The host container must carry
  `.focus-ring-host` (positioned + isolating); ticket 08 (Library) reuses
  the same component.
- The functional scrollbar (implementation ticket 07) is
  [FunctionalScrollbar.tsx](../../packages/frontend/src/components/FunctionalScrollbar.tsx)
  + [functionalScrollbar.css](../../packages/frontend/src/functionalScrollbar.css),
  mounted only by the Browse desktop grid: canvas dot-track/PAGE-graduation
  layer + DOM liquid-glass thumb, position/length LERP, idle auto-hide,
  pointer-capture drag with readout chip, track-click jump, and a parking
  rAF loop (`data-raf` reflects running/parked). It reads/writes the live
  lenis instance via `getLenis()` from `useLenis.ts`; lenis binds
  wrapper === content and runs with `naiveDimensions`, so `lenis.limit` is
  read live from the scroller on every access — cached dimensions can't see
  content growth here, and observing a page root node instead would freeze
  the limit when SPA route swaps detach it. Reduced
  motion never mounts the component and keeps the native thin scrollbar.
- Ticket 14 (spec §9) covered the auth pages and the mobile fallbacks:
  Login/Setup are typographic skeleton pages in
  [auth.css](../../packages/frontend/src/auth.css) (Clash title + mono
  ledger readings on `--pt-*`, glass only for the passkey focused overlay,
  [AuthFocus.tsx](../../packages/frontend/src/components/AuthFocus.tsx)).
  The mobile chrome (`styles.css` `.mobile-*` blocks) consumes the `--pt-*`
  tokens with ≥44px touch targets; the PlayerBar degrades to MiniPlayer +
  Sheet ([MobileMiniPlayer.tsx](../../packages/frontend/src/components/mobile/MobileMiniPlayer.tsx)),
  and Settings degrades to a section-list → detail flow
  ([SettingsMobile.tsx](../../packages/frontend/src/pages/SettingsMobile.tsx))
  that reuses the desktop section bodies exported from
  `SettingsDesktop.tsx`. The legacy `DirectoryPickerDialog` is gone — the
  glass directory-change focused flow (`DirectorySheet` in
  `SettingsDesktop.tsx`) serves both layouts.
- Keep the existing plain CSS system for not-yet-migrated pages. Reuse
  controls and icons from
  [icons.tsx](../../packages/frontend/src/icons.tsx).
- Keep mobile and desktop workflows consistent with the existing shell. Verify
  layout and interactions at both sizes using the browser suite and screenshots
  appropriate to the change.
- Logo assets are [favicon.svg](../../packages/frontend/public/favicon.svg) and
  [favicon.ico](../../packages/frontend/public/favicon.ico) (inverse rounded
  tile + lowercase Clash Display "p", spec §2.2; the SVG embeds the glyph
  outline, extracted from the self-hosted woff2 with fontTools). Regenerate
  the ICO from the SVG using `@resvg/resvg-js` in a temporary tooling
  directory (SVG to PNG to ICO), retaining 16/32/48px sizes. This avoids
  depending on a system `rsvg-convert` installation.
