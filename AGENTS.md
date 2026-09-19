# Agent Guide

Pi Wallpaper Engine plays Steam Workshop **Video** wallpapers on a Raspberry Pi 4B
(Debian Trixie, aarch64). The Bun workspace contains a web UI, a backend that owns
mpv, and an optional NAS transcode worker.

## Start Here

1. Read the task's spec or issue when one is provided, then the relevant guide
   below. Load only the sections needed for the change.
2. For code, architecture, or call paths, use `codegraph_explore` first. Refine the
   query for focused follow-up and follow the available tool's current description.
   Use `rg` and direct reads for docs, config, omitted source, or stale results.
   If Codegraph is unavailable or the project is unindexed, use those local tools.
3. Check the root and affected workspace `package.json` files for current scripts
   and dependencies. Validate with the checks described in the development guide.

## Task Guides

| When changing or investigating | Read |
| --- | --- |
| Backend services, shared schemas, HTTP contracts, downloads, storage, playback, or worker protocol | [Backend Guide](docs/agents/backend.md), especially the affected subsystem |
| Frontend UI, styles, icons, or browser tests | [Frontend](docs/agents/development.md#frontend) and [Validation](docs/agents/development.md#validation) |
| Installation, configuration, development servers, or service deployment | [Development Guide](docs/agents/development.md) |
| Passkey setup, session guards, or public exposure | [Authentication](docs/auth.md) and [Auth Boundaries](docs/agents/backend.md#auth-boundaries) |
| NAS worker configuration, images, or deployment | [Worker README](packages/worker/README.md) and [Deployment Guide](docs/worker-deployment.md) |
| Domain terminology, module ownership, or architectural decisions | [Domain Guide](docs/agents/domain.md), which indexes the glossary and relevant ADRs |
| Creating, fetching, or triaging a spec or issue | [Issue Tracker](docs/agents/issue-tracker.md) and [Triage Labels](docs/agents/triage-labels.md) |

## Shared Constraints

- Media paths in SQLite are relative. Resolve them through `Storage.mediaRoot()`;
  the configured default directory may no longer be the active root.
- SQLite state stays local when media moves. Storage's product model is directory
  selection, validation, and migration; retain that model for local and mounted drives.
- HTTP routes express intents. `DownloadIntake` owns download workflows, `Playback`
  owns playback coordination, and `StorageRootSelection` owns root-selection decisions.
- Downloads return promptly and run in the background. The Pi owns media placement;
  workers receive source bytes and upload artifacts through the worker protocol.
- Use `snake_case` for HTTP JSON, config keys, and SQLite columns; use `camelCase`
  inside TypeScript. Keep cross-package contracts in `@pwe/shared`.
- Keep commit subjects focused. In every agent workflow, put the actual model ID
  on its own line in the commit body: `Model: <model-id>`.

## Maintaining These Docs

Keep this file as the entry point and put subsystem details in the linked guides.
Use [CONTEXT.md](CONTEXT.md) for domain definitions and ADRs for decision history.
Commands and dependency versions come from scripts and manifests. When changing
behavior, update its owning guide and check any links affected by moved files.
