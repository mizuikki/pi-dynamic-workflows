# pi-dynamic-workflows

[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev)
[![tests](https://img.shields.io/badge/tests-679%20passing-success)](#development)

> **Claude Code–style dynamic workflows for [Pi](https://pi.dev).**
> Turn one prompt into a fleet of subagents that fan out in parallel, cross-check each other, and hand back a single synthesized answer.

**[Website](https://quintinshaw.github.io/pi-dynamic-workflows/) · [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)**

![pi-dynamic-workflows demo](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

Instead of one model grinding a task step by step, Pi writes a small JavaScript **orchestration script** that spawns many subagents at once, keeps the intermediate work in script variables (not your chat context), and returns only the result. It's the "code mode for subagents" from Claude Code — on any model Pi can reach.

Built for **codebase-wide audits, multi-perspective review, large refactors, and cross-checked research** — anything one context window can't hold.

## Install

Node.js 24 or newer is required. Workflow persistence uses Node's built-in
`node:sqlite` module and rejects older runtimes before opening any storage path.

```bash
pi install -l /absolute/path/to/pi-dynamic-workflows
```

Then `/reload` in Pi. This extension requires the sibling private Pi fork with
extension SDK API version `1` and model runtime API version `1`; upstream Pi is
not a compatible host. Remove the project-local source with:

```bash
pi remove /absolute/path/to/pi-dynamic-workflows -l
```

You get the `workflow` tool plus the `/workflows`, `/deep-research`, and `/adversarial-review` commands.

## Try it

Ask in plain language:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes the script and runs it in the background — your turn ends immediately and a live panel tracks progress while you keep working. Or just type **workflow** or **workflows** in any message to force one. To force one explicitly — even with the keyword trigger off — run `/workflows run <prompt>`. If that causes false triggers, set a custom trigger such as `pi-workflow` with `/workflows-trigger set pi-workflow` or by adding `{ "keywordTriggerWord": "pi-workflow" }` to `~/.pi/workflows/settings.json`. With that setting, only `pi-workflow` auto-arms workflows mode. If you only want to discuss workflows without triggering one, run `/workflows-trigger off`; preferences are saved for new sessions. Check the current state with `/workflows-trigger status`, and turn it back on with `/workflows-trigger on`.

![Workflows mode in the input box](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/workflows-mode.jpg)

If another Pi extension has already installed a custom editor component, pi-dynamic-workflows leaves it in place and keeps the submit-time workflow trigger active. In that compatibility mode, the animated keyword highlight and Backspace one-shot disarm affordance are skipped because the existing editor remains responsible for rendering and input handling; use `/workflows-trigger off` or `/workflows-trigger set <word>` when you need to discuss workflow/workflows without auto-triggering, including in future sessions. Editor composition is load-order dependent: whichever extension installs a visual editor last owns the editor surface, while pi-dynamic-workflows still keeps its submit-time hook registered.

## What a workflow looks like

Plain JavaScript. The first statement exports literal metadata; then you orchestrate:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, { tier: 'medium', isolation: 'worktree' }),
  ),
)

phase('Verify')
return await agent('Synthesize and double-check these findings:\n' + findings.join('\n\n'), { tier: 'big' })
```

`agent()` spawns an isolated subagent, `parallel()` runs many at once, `phase()` groups them in the live view, and `tier` routes each one to the right model. That's the whole idea.

## Highlights

- **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Up to 16 concurrent / 1000 total subagents; intermediate results stay in variables, not the chat.
- **Real model routing** — `small` / `medium` / `big` tiers (or an exact `model`) per agent. It actually switches the subagent's model — cheap work on a light one, hard synthesis on a big one.
- **Journaled resume** — an interrupted run replays finished agents from a journal (no re-run, no tokens) and runs only what's left or what you changed.
- **Git worktree isolation** — `isolation: "worktree"` gives an agent its own branch, so parallel agents can edit the same files without clobbering each other.
- **Real token & cost accounting** — read from each subagent's session, not estimated. Runs have no default token cap; `tokenBudget`, phase budgets, and `budget` let you add explicit gates when you want them.
- **Background by default** — the turn ends right away, a live "Workflows running" panel tracks runs, and each result is delivered back so the conversation auto-continues when it finishes. The panel is compact by default; `/workflows-progress detailed` expands it inline to per-phase/per-agent rows with tokens, cost, and a live tok/s rate (so a stalled agent shows as 0 tok/s) — no need to open `/workflows`.
- **Interactive `/workflows` TUI** — drill runs → phases → agents → detail; inspect per-agent failures and compact subagent history; pause, stop, restart, and save runs from the keyboard.
- **Quality patterns built in** — `verify()`, `judgePanel()`, `loopUntilDry()`, and `completenessCheck()` for adversarial review, best-of-N, and exhaustive discovery.
- **Ultracode** — `/ultracode` is a standing opt-in that auto-arms an exhaustive multi-agent workflow for every substantive message, the way Claude Code's ultracode does. `/effort high` is the lighter tier.
- **Bundled `/deep-research` + `/adversarial-review` + `/code-review`** — real web search, source cross-checking, cited reports, and a 7-angle parallel code review with a verify pass.
- **Saved & nested workflows** — turn any run into a `/<name>` command, and compose saved workflows from inside other scripts.

## How it maps to Claude Code dynamic workflows

The same model — on Pi, plus the production pieces a real run needs:

| Claude Code dynamic workflows | pi-dynamic-workflows (on Pi) |
| --- | --- |
| Code-mode orchestration — the model writes a script that drives subagents | A JS `workflow` tool running `agent()` / `parallel()` / `pipeline()` / `phase()` in a vm sandbox |
| Subagents with isolated context | Fresh in-memory Pi sessions; results held in script variables, not the chat |
| Structured outputs | JSON-Schema `schema` → a validated object, with bounded repair if the model misses |
| Background runs | Non-blocking by default, a live task panel, and auto-continue delivery |
| Resume | **Journaled + replayable** — survives restarts and replays the unchanged prefix |
| Model selection | **Per-agent / per-phase routing** across any provider Pi is authenticated for |
| Ultracode (standing maximal-effort opt-in) | **`/ultracode`** (or `/effort ultra`) — auto-arms an exhaustive workflow for every substantive message |
| — | **Git worktree isolation**, **real cost accounting**, **`/deep-research`**, and a **quality-pattern stdlib** |

## Commands

```text
/workflows                  open the interactive navigator (plain list in print mode)
/workflows status <id>      watch a run live; print its result when it finishes
/workflows save <name>      save the latest run's script as a reusable /<name> command
/workflows pause|resume|stop|rm <id>
/workflows-trigger off|on|status
                            persistently disable, restore, or inspect keyword triggering
/workflows-trigger set <word>|reset
                            customize or reset the keyword trigger word (default "workflow",
                            also matches "workflows"; custom words match exactly, case-insensitive)
/workflows run <prompt>     force a dynamic workflow from <prompt> on demand — the explicit
                            twin of the keyword trigger. Works even when the keyword trigger
                            is off (/workflows-trigger off); the run shows in the panel + /workflows.
/workflows-progress compact|detailed|status
                            switch the live panel between the compact one-liner and the detailed
                            per-phase/per-agent view (with tokens, cost, and a live tok/s rate)
/workflows-progress-max <N> cap agents shown per phase in detailed mode (1-1000, default 8)
/workflows-models           map the small / medium / big tiers to real models, optionally with thinking levels
/workflows-prompt enable    confirm and enable the project-local main-agent prompt
/workflows-prompt disable   disable the project-local main-agent prompt
/workflows-prompt status    inspect project prompt metadata (path, state, size, and hash only)
/ultracode [off]            ultracode: auto-arm an exhaustive workflow for every substantive message
/effort off|high|ultra      finer control over the standing opt-in (high = thorough, ultra = ultracode)

/deep-research <question>   web-researched, source-cross-checked report
/adversarial-review <task>  findings vetted by skeptical reviewers
/multi-perspective "<topic>" [angle …]
                            analyze a topic from several independent angles, then synthesize
/code-review [target]       7 parallel finder angles (correctness, reuse, simplification, efficiency,
                            altitude) + a verify pass → ranked findings
/codebase-audit <scope> "<check>" …
                            run parallel checks over a scope, then cross-validate and report
```

`/multi-perspective` and `/codebase-audit` take quoted arguments so a topic or check can be multiple words:

```
/multi-perspective "should we use Redis or Postgres for session storage"
/multi-perspective "JWT vs session cookies" security scalability developer-experience
/codebase-audit src/ "missing error handling" "unused exports" "inconsistent naming"
```

`/multi-perspective` needs a topic; with fewer than two angles it defaults to `technical, product, security, user experience, maintainability`. `/codebase-audit` needs a scope and at least one check.

`/code-review` reads its target from `[target]`, defaulting to your working diff when omitted:

```
/code-review                  review git diff HEAD (your working changes)
/code-review HEAD~3..HEAD     review a git range
/code-review src/foo.ts       review a git diff scoped to one path
/code-review 42               review gh pr diff 42 (needs the gh CLI + auth)
```

It fans out 7 finder agents in parallel — 3 on correctness (line-by-line scan, removed-behavior audit, cross-file call-site tracing), 3 on cleanup (reuse, simplification, efficiency), and 1 on abstraction-level fit — dedupes their candidates, verifies each one, and returns a ranked markdown report (correctness first, cleanup next, abstraction last, capped at the top 10). A diff over ~200k characters is truncated with a clear notice rather than silently cut or blowing up the prompt.

In the navigator: `↑/↓` select · `enter`/`→` open · `esc`/`←` back · `p` pause · `x` stop · `r` restart · `s` save · `q` quit. Each agent shows the model it ran on; the detail view shows its prompt, result, error diagnostics, and compact message/tool history.

## Storage

Workflow run history and resume journals for every project are stored in one SQLite database at `~/.pi/workflows/workflows.sqlite3`. Runs remain isolated by a stable project key and Pi session ID. Listing and the live panel use summary records; private prompts, scripts, results, errors, and journals are loaded only for an authorized run detail or resume operation. The workflow home is user-only and the database file is created with user-only permissions on supported platforms.

Global settings and model tiers remain text files at `~/.pi/workflows/settings.json` and `~/.pi/workflows/model-tiers.json`. Saved workflow definitions and project settings also remain file-backed under `~/.pi/workflows/projects/<project>/`. Existing run JSON, backup, temporary, and lock files are deliberately ignored: they are not imported, read as a fallback, or deleted. See [docs/storage.md](docs/storage.md) for the schema, durability, lease, backup, and recovery contract.

`model-tiers.json` uses Pi CLI-style model parsing. A tier can be a plain model spec or include an optional thinking suffix:

```json
{
  "tiers": {
    "small": "openai-codex/gpt-5.4-mini:low",
    "medium": "openai-codex/gpt-5.4:medium",
    "big": "openai-codex/gpt-5.5:xhigh"
  }
}
```

Use `/workflows-models` to edit these in the TUI: choose the base model first, then choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or the session default.

Older installations may still have object-valued tiers such as `{ "model": "provider/model", "thinkingLevel": "low" }`. They are read and migrated in memory to the string form above; saving the configuration writes the new format. Invalid tiers are skipped individually, so one damaged entry does not silently enable the default capability spread. Reading never rewrites the file. If the file does not exist, the initial defaults are spread across authenticated model capabilities rather than assigning every tier to the current model.

To avoid accidental keyword triggers, configure a custom trigger word in `~/.pi/workflows/settings.json`:

```json
{
  "keywordTriggerWord": "pi-workflow"
}
```

The default `"workflow"` preserves the legacy behavior and also matches `"workflows"`. Custom trigger words are literal, case-insensitive terms with no spaces and no leading slash; for example, `"pi-workflow"` does not match `"workflow"`, `"workflows"`, or `"pi-workflows"`.

## Main-agent project prompt

Create `.pi/WORKFLOW_MAIN.md` when a project needs instructions for the main Pi
agent only. The file is the single source of truth for this feature. It is read
live once per agent turn and appended after the system prompt with a stable
marker, so edits take effect without `/reload` and an already-marked prompt is
never duplicated. Empty, whitespace-only, missing, oversized, invalid UTF-8,
symlink, directory, and unreadable files are ignored safely. The maximum file
size is 64 KiB.

Loading requires both Pi project trust and an extension-owned, exact-project
opt-in. Pi's implicit trust/default-trust settings alone never authorize this
file. In an interactive session, run `/workflows-prompt enable` and confirm the
dialog. The opt-in is stored outside the repository at
`~/.pi/workflows/projects/<project-key>/settings.json`; there is no global or
parent-directory inheritance. `/workflows-prompt disable` removes the project
entry. In headless modes, the extension never prompts or writes authorization.
Use the explicit per-run `--workflow-main-prompt` flag for a headless run; it
does not persist. Pi's `--approve` remains only Pi's trust gate and does not
replace this opt-in.
The exported load/inspect helpers also fail closed unless the caller supplies
the trust gate and either this persisted opt-in or the explicit per-run access
option.

Workflow child sessions do not receive this prompt. `WorkflowAgent` filters the
host workflow extension by its known path and registered workflow tool/command,
which also protects custom and inline resource loaders. Native Trellis children
are recognized through `TRELLIS_SUBAGENT_CHILD=1`; package-owned launchers may
use `PI_DYNAMIC_WORKFLOWS_CHILD=1`. `TRELLIS_CONTEXT_ID` alone is not a child
identity signal.

`/workflows-prompt status` is read-only and reports only the relative path,
`project` source, state/reason, byte and character counts, and a short SHA-256
hash. It never prints prompt contents or records a diagnostic session entry.

### Migrating from `APPEND_SYSTEM.md`

Pi continues to load `.pi/APPEND_SYSTEM.md` exactly as before. Move only the
instructions that should apply to the main agent into `.pi/WORKFLOW_MAIN.md`;
leave shared or child-session instructions in `.pi/APPEND_SYSTEM.md`. There is
no automatic migration and this extension never reads `APPEND_SYSTEM.md`.
If the exact same text is present in both files, it is injected only once.

Custom resource loaders continue to provide `.pi/APPEND_SYSTEM.md` to child
sessions, while the host workflow policy is filtered before child extensions
bind. Inline resource-loader paths are covered by the extension identity check.

## Reference

The full guide — every global, agent option, `agentType` definitions, structured output, and determinism — lives on the **[website](https://quintinshaw.github.io/pi-dynamic-workflows/)**. The essentials:

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; recoverable failures return `null` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results in input order. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`. |
| `phase(title, { budget? })` | Group agents in the live view; optional per-phase token sub-budget. |
| `verify` / `judgePanel` / `loopUntilDry` / `completenessCheck` | Built-in quality patterns. |
| `workflow(name, args)` | Run a saved workflow inline (shares the global caps). |
| `checkpoint(prompt, opts)` | A journaled, replayable human approval gate. |
| `budget` | `{ total, spent(), remaining() }` real-token tracker. |

| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`; tiers may store `provider/modelId:thinking`). |
| `model` | Exact `provider/modelId` or `provider/modelId:thinking` (always wins over `tier`). |
| `agentType` | A named definition (`.pi/agents/<name>.md` project-level, or `~/.pi/agent/agents/<name>.md` user-level — `~/.pi/agents/<name>.md` still works as a deprecated fallback) binding tools + model + role prompt. |
| `isolation: "worktree"` | Run in a throwaway git worktree for conflict-free parallel edits. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / optional per-agent hard timeout. Omit `timeoutMs` for no hard timeout. |
| `retries` | Retry attempts after a recoverable failure (timeout, connection failure, empty output) for this agent. Overrides the run-level `agentRetries`. Default `0`. |

By default, workflows do not set a run-wide token budget or per-agent hard timeout. Use the `workflow` tool's `tokenBudget` / `agentTimeoutMs`, per-phase budgets, or per-agent `timeoutMs` only when you want an explicit cap. A global fallback timeout can also be set in `~/.pi/workflows/settings.json` as `{ "defaultAgentTimeoutMs": 600000 }`; set it to `null` or omit it for no default hard timeout.

For larger or flakier fan-outs, the `workflow` tool also accepts `concurrency` (max agents running at once, clamped to the runtime maximum of `16`) and `agentRetries` (retry attempts after a recoverable agent failure such as a timeout, connection failure, or empty output). Both can be defaulted in `~/.pi/workflows/settings.json` as `{ "defaultConcurrency": 4, "defaultAgentRetries": 2 }`; a per-run tool value overrides the default, and a per-agent `retries` overrides `agentRetries`. Retries default to `0` (off) unless configured or passed, and only recoverable failures retry — nonrecoverable errors still abort the run.

By default, each workflow subagent runs in an in-memory session: the full transcript is discarded when the run ends, and only a compacted excerpt survives in the workflow run payload. Set `{ "persistAgentSessions": true }` in `~/.pi/workflows/settings.json` (or a project-level override, which wins) to persist every subagent transcript as a real pi session file in the standard sessions directory for the project (`~/.pi/agent/sessions/<encoded-cwd>/`), named `workflow:<runId> <agent label>` so it's identifiable in `/resume` and other session tooling. Sessions are keyed by the project cwd even when an agent runs in a temporary git worktree. Default is `false` (current behavior). Caveat: large fan-out runs create one session file per agent, which can clutter session pickers. Caveat: unlike the compacted run payload, the persisted transcript is full and untruncated, so anything a subagent reads into context — including secrets — lands on disk when this is enabled. If a session can't be created or written (permissions, disk full), that agent silently falls back to an in-memory session rather than aborting the run.

The live "Workflows running" panel is configured in the same `~/.pi/workflows/settings.json`: `"progressPanelMode"` is `"compact"` (default, one line per run) or `"detailed"` (per-phase/per-agent rows with tokens, cost, and a live tok/s rate), and `"progressPanelMaxAgents"` (default `8`, range `1`–`1000`) caps how many agents each phase shows in detailed mode before a `… N earlier agents` line. Toggle them live with `/workflows-progress compact|detailed` and `/workflows-progress-max <N>` — changes take effect on the next render without a restart.

When a background run finishes, its bounded result summary is followed by `Run details: /workflows status <runId>`. The status command authorizes the run against the current Pi session and then loads that one payload. Only the JSON-dump fallback (a result object without a `verdict`/`report`/`summary` string field) is truncated — at `"deliveredResultMaxChars"` characters (default `400`) in the same `~/.pi/workflows/settings.json` — and the dropped size is shown inline, e.g. `…(truncated 3.2 KB)`.

Workflows run in a Node `vm` sandbox; `Date.now()`, `Math.random()`, `new Date()`, and `require`/`import`/`fs`/network are unavailable, so runs stay reproducible — which is what makes resume reliable.

## Default tier assignment

When no `~/.pi/workflows/model-tiers.json` exists, pi-dynamic-workflows builds a default config from the models you have authenticated. The registry returns models grouped by provider, not ranked by capability, so a naive positional spread (`first → small`, `last → big`) can put a mini or flash model in the big slot — or even collapse two tiers onto the same model. To avoid this, `buildDefaultTierConfig` first ranks every available model with a capability score based on well-known substrings: names containing `mini`, `flash`, `haiku`, `nano`, or `small` rank lowest, names containing `opus`, `pro`, `ultra`, `large`, or `plus` rank highest, and everything else ranks neutral (checks are case-insensitive; a name matching both hint sets ranks as small, so it can never outrank a bigger model). Models keep their registry order within the same rank. Tiers are then assigned from this single ranked pool — the least-capable model becomes `small`, the most-capable becomes `big`, and the middle-ranked one becomes `medium` — so distinct tiers never collapse onto the same model and a smaller model can never land in a higher tier than a bigger one. With fewer than 3 distinct models the assignment degrades gracefully: with 2 models the weaker one becomes `small` and the stronger one covers both `medium` and `big`; with 1 (or 0) models every tier resolves to that model (or the current Pi model / empty string as a last resort). You can review or override the assignment at any time with `/workflows-models`.

## Optional Trellis adapter

For a Trellis `1.0.1` project, pi-dynamic-workflows can optionally:

1. Inject **read-only Trellis task context** into workflow subagents (`agent()`), and
2. Register a host-facing **`trellis_subagent`** tool (`single` / `parallel` / `chain`) when the **native** Trellis extension is **absent**.

Both paths reuse the shared `WorkflowAgent` runtime. This package does **not** own Trellis lifecycle (`task.py create|start|archive`) or phase state.

### Enablement

Configured in `~/.pi/workflows/settings.json` (or a project override):

```json
{
  "trellisAdapter": {
    "enabled": "auto",
    "autoPrependActiveTaskLine": true,
    "registerSubagentTool": "auto"
  }
}
```

| `enabled` | Behavior |
| --- | --- |
| `"auto"` (default) | Enable context injection only when `<cwd>/.trellis/` exists and `.trellis/.version` is `1.0.1` |
| `"on"` | Attempt Trellis context resolution only for a `1.0.1` project |
| `"off"` | Never inject Trellis context (tool also stays off) |

At extension startup, any Trellis project whose `.trellis/.version` is not
`1.0.1` disables the adapter, registers no fallback tool, and emits a warning.
There is no compatibility renderer or fallback mode for another Trellis version.

| `registerSubagentTool` | Behavior |
| --- | --- |
| `"auto"` (default) | Register `trellis_subagent` only when adapter is enabled, `.trellis/` exists, **no** native Trellis extension path is present, and `getAllTools()` does not already list `trellis_subagent` |
| `"on"` | Force attempt to register; still **skips** with a warning if the tool name is already registered |
| `"off"` | Context-only mode (previous v1 behavior) |

### Duplicate registration / migration

- **Native Trellis extension present** (`.pi/extensions/trellis*` or `extensions/trellis*`): native Trellis owns the main session and its one `trellis_subagent`; the adapter injects context only into Workflow children and does **not** register a second tool.
- **Native extension removed**: set `registerSubagentTool` to `"auto"` (default). On `session_start`, the workflow extension registers `trellis_subagent` if the public API reports no existing tool with that name.
- Pi SDK has no official “unregister other extension’s tool” API and first registration per name wins. Fail closed: if `getAllTools()` throws or is unavailable, we **skip** registration rather than risk a silent dual tool.
- A supported project may load both extensions: native Trellis owns native dispatch, while this package owns only Workflow-child context injection.

### What context injection does

For `agent(prompt, { agentType: "trellis-implement" })` (or `trellis-check` / short names), the loader may prepend:

1. `Active task: <path>` when a task path was resolved without that line (`autoPrependActiveTaskLine`, default `true`)
2. A bounded `## Trellis Task Context` block with `prd.md`, optional `design.md` / `implement.md`, and a read-on-demand index of curated `implement.jsonl` / `check.jsonl` entries; referenced files are never inlined
3. A per-run `env.TRELLIS_CONTEXT_ID` applied to nested **bash** tool calls via a session-local `tool_call` interceptor (does **not** mutate parent `process.env` under parallel runs)

The canonical payload follows the Trellis `1.0.1` native renderer byte-for-byte:
the complete task-context prefix is capped at 128 KiB, each directly included
task artifact at 64 KiB, the manifest index at 32 KiB, and manifest source reads
at 256 KiB. Oversized content is marked with its source path so the subagent can
use targeted searches or ranged reads instead of paying for an unbounded first
request.

Resolution order (fail closed — never guess when ambiguous):

1. Prompt line `Active task: <path>`
2. `TRELLIS_CONTEXT_ID` / host session map under `.trellis/.runtime/sessions/*.json`
3. Single-session adopt (multiple sessions with tasks → no path + warning)
4. Read-only `python3 ./.trellis/scripts/task.py current --source`

### Host tool: `trellis_subagent`

Compatible surface with the native Trellis tool:

| Arg | Notes |
| --- | --- |
| `agent` | Trellis agent name (`trellis-implement`, `trellis-check`, …). Hard-fails unless `.pi/agents/<name>.md` exists |
| `mode` | `single` (default) / `parallel` / `chain` |
| `prompt` | Required for `single` |
| `prompts` | For `parallel` / `chain` (max **6**) |
| `model` | Optional `provider/id[:thinking]` override |
| `thinking` | Optional thinking level override |

Semantics:

- **single** — one `WorkflowAgent.run`
- **parallel** — `Promise.all`, join outputs with `\n\n---\n\n`
- **chain** — sequential; each step receives `Previous output:`; stop on first failure
- **implement/check** — forced **shared project cwd** (no worktree isolation)
- Progress: `details.kind === "trellis-subagent-progress"` with `runs[]` + throttled `onUpdate`

Dispatch prompt protocol (same as native): the delegated prompt should start with
`Active task: <path from task.py current>`.

### Hard boundaries

- Does **not** call `task.py create|start|finish|archive`
- Does **not** implement Trellis phase state machines, finish-work, or journal ownership
- Does **not** fork a second workflow manager
- Subagent child sessions filter the host workflow extension (and Trellis extension paths when the adapter is on) so they do not re-load host orchestration tools
- **Shared cwd for implement/check work**: `isolation: "worktree"` remains available for general workflows, but Trellis implement and check agents run in the shared project cwd
- In-process execution (not a `pi` CLI subprocess): shares host credentials/registry; differs from native subprocess isolation

### Examples

```js
// Workflow script in a Trellis project
agent(
  `Active task: .trellis/tasks/04-17-foo
Implement the acceptance criteria.`,
  { agentType: "trellis-implement" },
)
```

```text
# Host tool (when registered)
trellis_subagent({
  agent: "trellis-implement",
  mode: "single",
  prompt: "Active task: .trellis/tasks/04-17-foo\nImplement item 3."
})
```

### Migration from native-only setups

1. Keep `.trellis/` and `.pi/agents/trellis-*.md` as today.
2. Install/enable this package’s workflow extension.
3. Remove or disable `.pi/extensions/trellis` if you want this package to own dispatch.
4. Leave `trellisAdapter.registerSubagentTool` at `"auto"`.
5. Confirm the host tool list shows a single `trellis_subagent` (and `workflow`).

### Supported release pair

The supported clean-slate pair is Trellis `1.0.1` plus workflow `2.14.0`.
For a project-local Pi installation, use the immutable Git tag:

```bash
pi install -l git:github.com/mizuikki/pi-dynamic-workflows@v2.14.0
```

Run `npm run smoke:trellis-context` after `npm run build` to emit the V01-V12
bounded-context renderer evidence.


## Development

```bash
npm install --ignore-scripts
npm test     # biome + tsc + unit tests
```

Keep the Pi fork as sibling `../pi`. The direct Pi imports are runtime peers
with wildcard versions and local `file:../pi/packages/...` development
dependencies. Runtime capabilities, not Pi product versions, define
compatibility; do not add Pi packages as production dependencies or import Pi source.
Verify an immutable, clean fork commit without changing this checkout's
`node_modules`:

```bash
PI_FORK_DIR=../pi PI_FORK_REF=<commit> npm run test:pi-fork
```

The fork verifier consumes Pi's manifest after checking every SDK tarball digest,
then creates a system temporary fixture with `<temp>/pi` and `<temp>/project`.
It checks the real loader alias with poison packages and rejects an upstream host
before tools are registered. The fixture is not a repository `tmp/` directory.

## Credits

The "code mode for subagents" idea comes from Michael Livs' original [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project builds on it with real model routing, journaled resume, git-worktree isolation, cost accounting, an interactive TUI, and deep research.

## License

MIT — see [LICENSE](LICENSE).
