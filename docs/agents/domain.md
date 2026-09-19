# Domain Documentation

This repository has one domain context. Read [CONTEXT.md](../../CONTEXT.md) when
naming concepts or changing ownership boundaries, then the ADRs for the area involved.

| Area | Decision history |
| --- | --- |
| Administrator access | [0001: Passkey auth](../adr/0001-auth-passkey.md) |
| Download intake and cancellation | [0002: Persistent progress](../adr/0002-downloads-progress-sqlite.md), [0007: Process registry](../adr/0007-download-process-registry.md) |
| Playback and display | [0003: Power linkage](../adr/0003-display-power-linkage.md), [0004: Rotation](../adr/0004-playback-rotation.md), [0009: Orchestration](../adr/0009-playback-orchestration.md) |
| Storage selection | [0008: Root selection](../adr/0008-storage-root-selection.md) |
| Software validation | [0005: Acceptance-free testing](../adr/0005-acceptance-free-testing.md), [0006: Browser route mocking](../adr/0006-e2e-route-mocking.md) |

## Where Information Belongs

- `CONTEXT.md` defines domain terms. Keep definitions short and free of module
  paths, API fields, dependency versions, and implementation recipes.
- [Backend Guide](backend.md) describes current ownership and behavioral constraints.
  [Development Guide](development.md) describes commands, validation, and operation.
- `docs/adr/` records decisions and their tradeoffs. Historical code paths,
  counts, and implementation plans describe the state when an ADR was written;
  use current source and guides for today's behavior and commands.
- [Local specs and issues](issue-tracker.md) hold work in progress.

Use glossary terms in issue titles, tests, and design discussions. Add or refine a
term when its meaning becomes clear. When a proposed change contradicts an ADR,
state the conflict and reason; update the decision record when the change is adopted.
Create new ADRs for durable choices with meaningful alternatives, not routine edits.
