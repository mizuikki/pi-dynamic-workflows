# Architecture

Pi Workflow Orchestrator is a strict TypeScript extension for the local Pi fork.
It keeps the existing tested workflow engine under a clean product identity; it
does not introduce a second scheduler or service.

## Runtime ownership

The Pi main agent writes validated JavaScript orchestration scripts and invokes
the permanent `workflow` tool. `WorkflowManager` owns foreground and background
runs, child agents, retries, run-wide abort and drain, SQLite persistence and
leases, journals, worktrees, structured output, shared storage, and terminal UI
state. Every Pi child completes and awaits one `session_shutdown` event before
its session is disposed.

Pi owns project trust, the available-and-scoped model boundary, supported
thinking levels, provider retry defaults, and ordinary tool policy. Workflow
admission snapshots one concrete default model and effort pair. An individual
`agent()` call may explicitly override that pair. `/workflow intensity` controls
orchestration width only; it is independent of model reasoning effort.

There are no human checkpoints or confirmation callbacks in workflow scripts.
Stale active runs become paused and resume only through an explicit
`/workflow resume` command. Resume replays completed journal entries and warns
that unfinished agents may execute again. The extension does not classify or
reconcile external side effects.

## Product boundary

The extension registers one command root, `/workflow`, and one permanent
model-facing tool, `workflow`. Saved project and global JSON workflows are
addressed as `@name`; saving one never creates a slash command. The package does
not provide fixed scenarios or bundled Web search/fetch tools.

State is clean-slate under `~/.pi/workflow-orchestrator`. The extension does not
read, migrate, modify, or remove state from the former product root. Existing
databases at the new path are admitted read-only before permissions or writable
SQLite settings can change them. Schema and payload remain version 1.

## Trellis ownership

Trellis compatibility is strict at `1.0.4`. The adapter injects bounded,
read-only task context into workflow children. Receiver-bound native session
identity wins; lossy normalization includes a hash of the original identity,
and explicit child `TRELLIS_CONTEXT_ID` is forwarded only through the controlled
child path. The adapter never scans unrelated session pointers or adopts a
singleton process key.

`trellis_subagent` is the only conditional second tool. In `auto` mode it is
registered only for a supported Trellis project when no native Trellis
extension or existing tool owns that name. Native Trellis continues to own task
lifecycle and phase state.

## Optional Keel bridge

Keel integration negotiates only `pi-workflow-orchestrator-host/v1`. Keel owns
business identity, controlled context tools, context snapshots, and lifecycle
observation. Workflow Orchestrator keeps execution, retry, persistence, and
child-session ownership. The former ABI is not accepted as an alias, and Keel
is not a production dependency of this package.

## Compatibility and installation

The extension factory preflights `extensionSdkApiVersion`,
`modelRuntimeApiVersion`, and `retryPolicySnapshotApiVersion`, all at version 1,
before registration or state access. Compatibility is verified with the pinned
archived Pi fork fixture, its SHA-256-verified four-package SDK manifest, and the
real Pi loader. Pi product versions are not used as extension compatibility
ranges.

The package is private and locally installed only:

```bash
pi install -l <absolute-source-path>
pi remove <absolute-source-path> -l
```
