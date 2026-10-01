# ADR 0011: The machine gates run locally, not on GitHub Actions

## Status

Accepted, 2026-10-02.

## Context

ADR 0005 made hosted CI the keystone of acceptance-free iteration: a green
Actions run was the async signal that a change could be trusted without a human
re-check. Two workflows carried that signal: ci.yml (test, typecheck, build,
Worker image smoke) and e2e.yml (Playwright).

The E2E workflow was the weak link. Its probes are timing-sensitive, and a shared
runner is the wrong clock for them: in PR 22 the player-bar popover check sampled
opacity 0.147 against a 0.5 threshold while the same commit passed locally, and the
browse probes failed on the runner and passed on a local rerun of the same commit.
A red run therefore carried no information about the change, which is exactly the
property ADR 0005 needed from it. The owner asked for the workflows to be removed
rather than tuned.

## Decision

Delete .github/workflows/ci.yml and .github/workflows/e2e.yml, and disable Actions
for the repository so a stray workflow cannot run silently.

The gates themselves stay in the repository as local commands, documented in the
Development Guide: bun test, bun run typecheck, bun run build,
bash scripts/smoke-test-worker-image.sh, bun run test:e2e. Agents report which
commands they ran.

## Consequences

- A green run is again an agent claim rather than an artifact a reviewer can
  inspect; a skeptical human re-runs the commands. ADR 0005 accepted that cost
  only because the artifact was trustworthy, and it was not.
- Nothing on the GitHub side gates a merge, and no runner minutes go to a suite
  whose failures do not reproduce off-runner.
- Hardware validation was never inside the CI boundary: the Pi still owns
  playback, display, and NAS evidence.
- Reinstating hosted CI means re-enabling Actions and re-adding a workflow; the
  local commands are unchanged either way.
