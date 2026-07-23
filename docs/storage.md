# Workflow run storage

pi-dynamic-workflows requires Node.js 24 or newer and stores runtime state for
all projects in one database:

```text
~/.pi/workflows/workflows.sqlite3
~/.pi/workflows/workflows.sqlite3-wal
~/.pi/workflows/workflows.sqlite3-shm
```

The workflow home is tightened to mode `0700` and the database to `0600` on
POSIX systems. The parent directory is the access boundary for temporary WAL
and shared-memory files. Settings, model tiers, project settings, and saved
workflow definitions remain file-backed.

## Version 1 contract

Schema v1 is identified by `PRAGMA application_id = 1346656070` and
`PRAGMA user_version = 1`. It contains four `STRICT, WITHOUT ROWID` tables:

| Table | Primary key | Contents |
| --- | --- | --- |
| `projects` | `project_id` | Canonical cwd binding and timestamps |
| `workflow_runs` | `project_id, run_id` | Indexed status, timing, agent/token counts, session ownership, payload version |
| `workflow_run_payloads` | `project_id, run_id` | Valid JSON containing the resumable run payload |
| `workflow_run_leases` | `project_id, run_id` | Owner PID, random fencing token, acquisition time, heartbeat time |

`workflow_runs` has indexes on `(project_id, session_id, updated_at DESC)`,
`(project_id, session_id, status, updated_at DESC)`, and
`(project_id, status)`. Payload rows cascade from run rows. Run and lease rows
cascade from project rows. A lease may exist before its run row, so leases
reference the project rather than the run.

The complete canonical DDL is exported as `WORKFLOW_SCHEMA_DDL` from the
internal database module and is verified exactly at open time. Identity,
version, integrity, foreign keys, table flags, columns, indexes, foreign keys,
and the complete non-internal schema-object set must match. Existing databases
are first inspected through a read-only connection. Unknown, altered, corrupt,
or newer databases fail closed and are preserved; the extension never resets
them automatically.

There is intentionally no migration path for old per-run JSON, `.bak`, `.tmp`,
or `.lock` files. Those files are ignored and left untouched.

## Durability and transactions

Accepted connections use foreign keys, WAL mode, `synchronous=FULL`, a 5-second
busy timeout, and a 1,000-page automatic checkpoint. Summary and payload writes
commit together under `BEGIN IMMEDIATE`; rollback leaves both at their previous
checkpoint. `FULL` is intentional because this database is the sole resumable
run store and recent committed checkpoints must receive SQLite's strongest WAL
sync behavior.

See the [Node.js 24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
and [SQLite synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous)
for the runtime and durability contracts. Node documents `node:sqlite` as
Stability 1.2 (release candidate), so upgrading Node should include the full
storage test suite.

## Scoping and privacy

`project_id` is the cwd-derived `workflowProjectKey`; its resolved cwd is stored
to detect collisions. Full payload access is additionally authorized by the Pi
session that created the run. List and panel queries read summary columns only.
Status, save, restart, and resume authorize a keyed summary before selecting one
payload, then verify the immutable session identity again after decoding.

Payloads can contain scripts, arguments, prompts, results, journals, errors,
and compact tool history. Diagnostics therefore avoid payload values and full
user-specific database paths. A background completion message points to
`/workflows status <runId>` instead of exposing a filesystem path.

## Renewable fenced leases

Active runs renew a lease every 10 seconds and leases become stale after 60
seconds without a successful renewal. Acquisition is serialized by
`BEGIN IMMEDIATE`. A dead owner PID permits early takeover; an expired heartbeat
permits takeover even if the PID is live, which handles PID reuse. PID liveness
alone is never proof of ownership.

Every save and delete is fenced by the random owner token. A stale owner cannot
write or release a successor's lease. A manager that loses renewal aborts its
execution and suppresses stale terminal writes. Active deletion aborts and waits
for execution settlement before performing the guarded transaction.

## Backup and recovery

No automatic backup, retention, pruning, or vacuum schedule is implemented.
For a consistent online copy, use the asynchronous `backup()` API from
`node:sqlite`; do not copy only the main file while a process may have WAL data.
Stop Pi before replacing or moving a database. Preserve a rejected database for
diagnosis, restore a known-good SQLite backup as the complete database, and
restart Pi. The extension will validate it before any mutation.

## Performance verification

Run the isolated benchmark with:

```bash
npm run benchmark:persistence
```

It reports summary listing, one keyed payload load, transactional save, 1/8/16
active lease-heartbeat scenarios, and event-loop delay. Render correctness is
verified separately by call-count tests: 1,000 panel and navigator renders must
perform zero persistence operations after their snapshots are prepared. Timing
alone is not accepted as proof that SQL stayed out of render methods.
