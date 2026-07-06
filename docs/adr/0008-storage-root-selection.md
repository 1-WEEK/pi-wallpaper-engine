# ADR 0008: Storage root selection lives in a dedicated module

## Status

Accepted, 2026-06-29. Revised, 2026-07-05.

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

Deepen storage-root selection into a dedicated `StorageRootSelection` Effect
service (`packages/backend/src/services/StorageRootSelection.ts`); keep
migration execution in `Migrate`; preserve all observable behavior.

The earlier decision kept switch orchestration in the route to avoid a
`Storage -> Migrate -> Storage` layer cycle. The revised design still avoids
that cycle by making the new module return a `SwitchPlan` instead of calling
`Migrate.start()` itself. The route executes the plan.

**Move into `StorageRootSelection`:**

- `listLocations()` — existing allowed roots as picker suggestions.
- `browseDirectories(path)` — validated subdirectory listing.
- `createDirectory(parent, name)` — validated `mkdir`.
- `validateTarget(path)` — writability, free/total bytes, emptiness, existing
  `source/` & `optimized/`.
- `planSwitch(targetRoot)` — validate/fence the target and decide whether the
  caller should keep the current root, persist the new root immediately, or
  start a background migration.

`validateTarget()` and `planSwitch()` share one internal target type:

```ts
type ValidatedStorageRoot = {
  path: string
  freeBytes: number
  totalBytes: number
  usedBytes: number
  isEmpty: boolean
  hasSource: boolean
  hasOptimized: boolean
}
```

The HTTP route maps this to the existing snake_case response fields and adds
`display_path` plus user-facing copy.

The **allowed-roots fence is enforced inside every path-taking method**, not as
a separate guard the caller must remember to invoke. The whitelist itself is
**kept unchanged** — same roots, same `realpath` escape detection. It is a sane
guardrail for the single-admin owner, not a hardened sandbox; we neither weaken
it nor gold-plate it.

The move is ownership-only for this policy: no new allowed roots, no removed
allowed roots, and no changed escape semantics. Policy names may become clearer
inside the module, but HTTP callers do not receive a new `allowedRoots` surface.

`planSwitch(targetRoot)` owns the switch decision and the business busy checks:

- target equals current root -> `noop`;
- empty library and changed target -> `save`;
- non-empty library and changed target -> `migrate`;
- active downloads -> fail `Busy`;
- active transcodes -> fail `Busy`.

`planSwitch()` returns only the minimal executable decision:

```ts
type SwitchPlan =
  | { action: "noop"; target: ValidatedStorageRoot }
  | { action: "save"; target: ValidatedStorageRoot }
  | { action: "migrate"; target: ValidatedStorageRoot }
```

It does not return `StorageState`, migration status, or any HTTP response shape.
After executing the plan, the route continues to call the existing composed
status query.

**Stays outside `StorageRootSelection`:**

- Migration execution: rsync space check, active playback guard, copy, verify,
  persisted-root commit, and old-root cleanup remain in `Migrate.start()`.
  Those are execution-time migration guards, not root-selection decisions.
- The route remains an HTTP adapter and plan executor: `noop`/`save` uses
  `storage.saveRoot()`, `migrate` uses `migrate.start()`.
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

**Testing:** `StorageRootSelection`'s interface is the primary test surface.
Use temp-dir tests for fs-dependent cases, including sibling-prefix escape,
symlink escape, relative paths, control characters, non-existing paths,
directory listing/sorting, directory creation name validation, and switch-plan
decisions (`noop` / `save` / `migrate` / `Busy`). Route tests stay thin and
cover only HTTP contract preservation plus execution of `save` vs `migrate`
plans.

**Naming convention (recorded):** `snake_case` at boundaries (HTTP JSON, config
file keys, SQLite columns); `camelCase` for internal TypeScript. New `Storage`
methods are internal → camelCase; the JSON fields they feed stay snake_case.

**Landing:** two PRs. PR1 = helper dedup only (mechanical,
behavior-preserving, machine gate proves it): `expandHome`, finished-download
predicate, and active-transcode status/query helper. PR2 = introduce
`StorageRootSelection`, move browse/fence/validate/switch planning into it, and
add module tests plus thin route contract tests.

## Consequences

- The allowed-roots security fence becomes unit-testable for the first time, off
  the HTTP path; new selection paths cannot forget to validate.
- `Storage` becomes a deep module covering the storage-root domain; the route
  drops to a thin HTTP adapter plus the one orchestration it legitimately owns.
- Switch decision is testable without booting the HTTP stack; migration
  execution remains separately tested at the `Migrate` interface.
- `normalizeCustomRootPath` / `isPathInsideRoot` stay exported pure helpers
  (`Migrate` still imports `isPathInsideRoot`).
- Behavior and the `/api/storage/*` contract are unchanged; the frontend is
  untouched. Acceptance is the machine gate (ADR 0005).
