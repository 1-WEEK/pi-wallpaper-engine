# ADR 0008: Storage root selection lives in Storage, switch orchestration stays at the route

## Status

Accepted, 2026-06-29.

## Context

`routes/storage.ts` (~399 lines) had become the real owner of storage-root
selection. It carried the domain logic that `Storage.ts` (~168 lines, 4 simple
methods) should own:

- **Location enumeration & directory browsing** — the allowed-roots policy,
  symlink-escape detection via `realpath`, control-character filtering
  (`candidateRoots`, `existingAllowedRoots`, `assertInsideAllowedRoots`,
  `/directories`).
- **Target validation** — writability, free space, emptiness, `source/` &
  `optimized/` probing (`validateTargetRoot`).
- **Switch orchestration** — busy-check (active downloads / transcodes) then
  decide instant switch vs. background rsync migration (`POST /root`).

This left `Storage` shallow (the interface was nearly as complex as the
implementation) and, more importantly, left the **allowed-roots security fence
with zero unit tests** — it can only be exercised today by booting the full HTTP
stack.

Architecture review of 2026-06-27 flagged this as candidate 2 ("strongly
recommended", second priority). The review proposed giving `Storage` a
`switchRoot(path)` method. **That is not buildable as stated:** `Migrate`
consumes the `Storage` service (`Migrate.ts` does `yield* Storage` and calls
`storage.mediaRoot()` / `storage.saveRoot()`), and `StorageLive` is provided
below `MigrateLive` in the layer graph. A `Storage.switchRoot()` that called
`Migrate.start()` would form a `Storage → Migrate → Storage` layer cycle that
Effect cannot construct.

This is also a contract-frozen surface: the `/api/storage/*` status/body
contract is a BL-2 item requiring sign-off (see ADR 0005). The work must be
behavior-preserving so the machine gate alone can accept it.

## Decision

Deepen `Storage` with the **pure root-domain** logic; keep the **switch
orchestration at the route**; preserve all observable behavior.

**Move into `Storage` (deps: Config + fs only — no cycle):**

- `listLocations()` — existing allowed roots as picker suggestions.
- `browseDirectories(path)` — validated subdirectory listing.
- `createDirectory(parent, name)` — validated `mkdir`.
- `validateTarget(path)` — writability, free/total bytes, emptiness, existing
  `source/` & `optimized/`.

The **allowed-roots fence is enforced inside every path-taking method**, not as
a separate guard the caller must remember to invoke. The whitelist itself is
**kept unchanged** — same roots, same `realpath` escape detection. It is a sane
guardrail for the single-admin owner, not a hardened sandbox; we neither weaken
it nor gold-plate it.

**Stays at the route:**

- Switch orchestration (`POST /root`): the busy-check, the
  instant-switch-vs-migrate decision, and the call to `Migrate.start()` /
  `storage.saveRoot()`. It has exactly one caller and sits at the composition
  root; folding it into `Storage` would cycle the layer graph (above).
- The **data-loss busy-check** (refuse a root switch while downloads or
  transcodes are active) is distinct from the whitelist and is retained — it
  protects the user from losing files written to the old root mid-migration.
- All **presentation**: `~`-style `display_path` formatting and user-facing
  copy/messages. `Storage` returns raw facts (real paths, byte counts,
  booleans); the route formats. This matches the existing `status()`.

**Deduplicate as plain shared helpers/constants** (not service methods — a
method on `TranscodeQueue` would be unreachable from the lower-level `Migrate`):

- `expandHome` (3 copies) → a backend `paths.ts` util (preflight runs outside
  the service graph, so it must be a plain function).
- `isFinishedTask` (2 copies) → exported from `DownloadTasks.ts` (task domain).
- the active-transcode status set `('claimed','running','uploading')` → a
  low-level shared constant importable by `Migrate`, the route, and the
  transcode modules.

**Testing:** split by what each level can actually catch — pure-function tests
for cheap path logic (`..`, sibling-prefix `foo`/`foobar`, control chars) and
temp-dir tests (`mkdtempSync`) for fs-dependent cases, including a real symlink
that escapes an allowed root.

**Naming convention (recorded):** `snake_case` at boundaries (HTTP JSON, config
file keys, SQLite columns); `camelCase` for internal TypeScript. New `Storage`
methods are internal → camelCase; the JSON fields they feed stay snake_case.

**Landing:** two PRs. PR1 = the dedup (mechanical, behavior-preserving, machine
gate proves it). PR2 = move browse/validate/security into `Storage` + tests,
built on the deduped helpers.

## Consequences

- The allowed-roots security fence becomes unit-testable for the first time, off
  the HTTP path; new selection paths cannot forget to validate.
- `Storage` becomes a deep module covering the storage-root domain; the route
  drops to a thin HTTP adapter plus the one orchestration it legitimately owns.
- Switch orchestration is *not* extracted into its own module — accepted, to
  avoid a single-caller module and a layer cycle. If a second caller ever
  appears, revisit.
- `normalizeCustomRootPath` / `isPathInsideRoot` stay exported pure helpers
  (`Migrate` still imports `isPathInsideRoot`).
- Behavior and the `/api/storage/*` contract are unchanged; the frontend is
  untouched. Acceptance is the machine gate (ADR 0005).
