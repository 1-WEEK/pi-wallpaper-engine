# Local Issue Tracker

Specs and implementation issues live under `.scratch/<feature-slug>/`:

| Artifact | Path |
| --- | --- |
| Spec or PRD | `spec.md` |
| Individual issue | `issues/<NN>-<slug>.md`, numbered from `01` |
| Exploration map, when used | `map.md` |

`.scratch/` is gitignored local working context. Keep durable decisions in
[domain docs](domain.md) and repository-level progress in
[iteration-backlog.md](../../plans/iteration-backlog.md).

## Tracker Operations

- **Publish a spec or issue:** create the corresponding file above, one issue per
  file. Record `Status:` near the top using the existing effort's convention and
  [triage labels](triage-labels.md) for readiness decisions.
- **Fetch a ticket:** read its referenced path. Ticket numbers are local to an
  effort; when only a number is supplied, use the current effort to resolve it.
- **Comment:** append under `## Comments` in the issue file.
- **Finish:** record the result and validation evidence and update its status.
  Existing implementation issues use `done` or `closed`; preserve the effort's
  terminal vocabulary.

## Exploration Maps

Use this workflow for efforts that already have a map or explicitly request one.
The map holds Notes, Decisions-so-far, and Fog; child tickets hold one question each.

- Tickets use `Type: research|prototype|grilling|task` and execution states
  `open`, `claimed`, `resolved`, or `backlog`. These are separate from triage roles.
- `Blocked by: NN, NN` lists dependencies. A ticket becomes unblocked when all
  listed tickets are `resolved`.
- The frontier is the lowest-numbered open, unblocked, unclaimed ticket.
  A `backlog` ticket is deferred and stays outside the frontier.
- Before work, save `Status: claimed`. On completion, append `## Answer`, set
  `Status: resolved`, and add a gist plus a relative ticket link to the map's
  Decisions-so-far section.
