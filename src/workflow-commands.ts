/**
 * `/workflow` slash command: the single user-facing workflow dispatcher.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { recomputeWorkflowSnapshot, renderWorkflowText, type WorkflowSnapshot } from "./display.js";
import { handleWorkflowIntensityCommand, type IntensityState, intensityDirective } from "./intensity-command.js";
import { handleWorkflowMainPromptCommand } from "./main-agent-prompt.js";
import { readRequiredHostRetryPolicy } from "./retry-policy.js";
import type { PersistedRunState, WorkflowRunSummary } from "./run-persistence.js";
import { parseCommandArgs } from "./saved-commands.js";
import {
  buildForcedWorkflowPrompt,
  handleWorkflowProgressCommand,
  handleWorkflowTriggerCommand,
  WORKFLOW_TOOL_NAME,
  type WorkflowModeState,
} from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { openWorkflowModelEditor } from "./workflow-model-command.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
import { isWorkflowStructuredOutputEnabled, type WorkflowSettingsStore } from "./workflow-settings.js";
import { openWorkflowNavigator } from "./workflow-ui.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

const USAGE =
  "Usage: /workflow [list] | run <request|@name> | status/watch/stop/pause/resume/rm <id> | list --saved | show/delete @name | save <name> [runId] | model | trigger ... | progress ... | prompt ... | intensity off|high|ultra";

const RUN_USAGE = "Usage: /workflow run <request> | /workflow run @name [--project|--global] [-- <args>]";

function summarizeRun(run: WorkflowRunSummary): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const done = run.agentCounts.done;
  const total = run.agentCounts.total;
  const tokens = run.tokenUsage ? ` · ${run.tokenUsage.total.toLocaleString()} tok` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}

function oneLineProgress(snapshot: WorkflowSnapshot): string {
  const total = snapshot.agents.length;
  const done = snapshot.agents.filter((a) => a.status === "done").length;
  const running = snapshot.agents.filter((a) => a.status === "running").length;
  const errs = snapshot.agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  return `◆ ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}`;
}

/**
 * Subscribe to a running run's events and stream live progress to the status bar,
 * printing the final snapshot when it finishes. Non-blocking: returns true if the
 * run was active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 */
function watchRun(manager: WorkflowManager, pi: ExtensionAPI, ctx: ExtensionCommandContext, id: string): boolean {
  const active = manager.getRun(id);
  if (active?.status !== "running") return false;

  const key = `wf:${id}`;
  const update = () => {
    const run = manager.getRun(id);
    if (run) ctx.ui.setStatus(key, oneLineProgress(run.snapshot));
  };
  const onEvent = (e: { runId?: string }) => {
    if (!e || e.runId === id) update();
  };
  let settled = false;
  const progressEvents = ["agentStart", "agentEnd", "phase", "log"];
  const finalEvents = ["complete", "error", "stopped", "paused"];
  const finish = (e: { runId?: string }) => {
    if (e && e.runId !== id) return;
    if (settled) return;
    settled = true;
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const ev of finalEvents) manager.off(ev, finish);
    ctx.ui.setStatus(key, undefined);
    const run = manager.getRun(id);
    if (run) {
      void pi.sendMessage({
        customType: "workflows",
        content: renderWorkflowText(recomputeWorkflowSnapshot(run.snapshot), true),
        display: true,
      });
    }
  };
  for (const ev of progressEvents) manager.on(ev, onEvent);
  for (const ev of finalEvents) manager.on(ev, finish);
  update();
  return true;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${run.status}`];
  if (run.defaultModel) {
    lines.push(`  default Workflow Model: ${run.defaultModel}${run.defaultEffort ? ` @ ${run.defaultEffort}` : ""}`);
  }
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of run.agents) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(
      `  ${icon} ${agent.label}${agent.model ? ` — ${agent.model}` : ""}${agent.effort ? ` @ ${agent.effort}` : ""}`,
    );
  }
  if (run.tokenUsage) lines.push(`  tokens: ${run.tokenUsage.total.toLocaleString()}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling saved-workflow subcommands. */
  storage?: WorkflowStorage;
  /** Working directory for settings and saved workflows. */
  cwd?: string;
  /** Standing orchestration intensity shared with the editor input hook. */
  intensity?: IntensityState;
  modeState?: WorkflowModeState;
  settingsStore?: WorkflowSettingsStore;
}

function parseSavedScope(parts: string[], allowAll = false): { scope?: "project" | "global" | "all"; error?: string } {
  const separator = parts.indexOf("--");
  const optionParts = separator >= 0 ? parts.slice(0, separator) : parts;
  const flags = ["--project", "--global", ...(allowAll ? ["--all"] : [])].filter((flag) => optionParts.includes(flag));
  if (flags.length > 1) return { error: `Conflicting saved-workflow scope flags: ${flags.join(", ")}` };
  if (!allowAll && optionParts.includes("--all")) return { error: "--all is valid only with /workflow list --saved" };
  const flag = flags[0];
  return { scope: flag ? (flag.slice(2) as "project" | "global" | "all") : undefined };
}

function savedName(ref: string | undefined): string | undefined {
  return ref?.startsWith("@") && ref.length > 1 ? ref.slice(1) : undefined;
}

function renderSavedWorkflow(saved: SavedWorkflow): string {
  return [`@${saved.name} [${saved.location}]`, saved.description, "", saved.script].join("\n");
}

/** Register the sole `/workflow` command against the shared manager. Idempotent. */
export function registerWorkflowCommand(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: WorkflowCommandOptions = {},
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflow");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflow", {
    description:
      "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume <id> | rm <id> | save <name> [runId]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) => pi.sendMessage({ customType: "workflows", content: text, display: true });

      switch (sub) {
        case "run": {
          const request = args
            .trim()
            .slice(parts[0]?.length ?? 0)
            .trim();
          if (!request) {
            ctx.ui.notify(RUN_USAGE, "warning");
            return;
          }

          const reference = savedName(parts[1]);
          if (reference) {
            if (!opts.storage) {
              ctx.ui.notify("Saved workflows are not available (no storage configured)", "error");
              return;
            }
            const parsedScope = parseSavedScope(parts.slice(2));
            if (parsedScope.error) return ctx.ui.notify(parsedScope.error, "warning");
            const scope = parsedScope.scope as "project" | "global" | undefined;
            const saved = opts.storage.load(reference, scope);
            if (!saved) {
              ctx.ui.notify(`No saved workflow "@${reference}"${scope ? ` in ${scope}` : ""}`, "error");
              return;
            }
            const separator = parts.indexOf("--");
            const rawSavedArgs = separator >= 0 ? parts.slice(separator + 1).join(" ") : "";
            try {
              const { runId, promise } = manager.startInBackground(
                saved.script,
                parseCommandArgs(rawSavedArgs, saved.parameters),
                {
                  hostRetryPolicy: readRequiredHostRetryPolicy(ctx),
                  structuredOutputEnabled: isWorkflowStructuredOutputEnabled(opts.cwd ?? process.cwd()),
                },
              );
              void promise.catch(() => undefined);
              ctx.ui.notify(`Started @${saved.name} [${saved.location}] as ${runId}`, "info");
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
            return;
          }

          // Best-effort: ensure the workflow tool is active (session_start usually has).
          // Add-only so this does not interfere with the keyword hook's save/restore state.
          try {
            const active = pi.getActiveTools?.() ?? [];
            if (!active.includes(WORKFLOW_TOOL_NAME)) pi.setActiveTools?.([...active, WORKFLOW_TOOL_NAME]);
          } catch {
            // ignore — the forced directive is the real forcing primitive
          }

          const intensity = opts.intensity;
          const structuredOutputEnabled = isWorkflowStructuredOutputEnabled(opts.cwd ?? process.cwd());
          const extra =
            intensity && intensity.level !== "off"
              ? intensityDirective(intensity.level, structuredOutputEnabled)
              : undefined;
          const forced = buildForcedWorkflowPrompt(request, extra);
          ctx.ui.notify(`Forcing workflow: ${request.slice(0, 60)}${request.length > 60 ? "…" : ""}`, "info");
          try {
            await pi.sendMessage(
              { customType: "workflow-run", content: forced, display: true },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            ctx.ui.notify("Could not start the workflow turn.", "error");
          }
          return;
        }
        case "ui":
        case "list": {
          if (parts.includes("--saved")) {
            if (!opts.storage) {
              ctx.ui.notify("Saved workflows are not available (no storage configured)", "error");
              return;
            }
            const parsedScope = parseSavedScope(parts, true);
            if (parsedScope.error) return ctx.ui.notify(parsedScope.error, "warning");
            const scope = parsedScope.scope;
            const saved = opts.storage.list(scope);
            await print(
              saved.length
                ? ["Saved workflows:", ...saved.map((wf) => `@${wf.name} [${wf.location}]  ${wf.description}`)].join(
                    "\n",
                  )
                : "No saved workflows.",
            );
            return;
          }
          // Interactive navigator when a UI is available; plain text otherwise
          // (print/RPC mode) or when the user explicitly asks for `list`.
          if (sub !== "list" && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, {
              storage: opts.storage,
              cwd: opts.cwd,
              readHostRetryPolicy: () => readRequiredHostRetryPolicy(ctx),
            });
            return;
          }
          if (parts.length === 0 && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, {
              storage: opts.storage,
              cwd: opts.cwd,
              readHostRetryPolicy: () => readRequiredHostRetryPolicy(ctx),
            });
            return;
          }
          const runs = manager.listRuns();
          if (!runs.length) {
            await print("No workflow runs yet. Start one with a background workflow (background: true).");
            return;
          }
          await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
          return;
        }
        case "watch":
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          // A running run streams live progress to the status bar and prints the
          // final snapshot when it finishes — no need to re-run the command.
          if (watchRun(manager, pi, ctx, id)) {
            ctx.ui.notify(`Watching ${id} — live progress in the status bar; result prints when it finishes.`, "info");
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(recomputeWorkflowSnapshot(live), false));
            return;
          }
          const run = manager.loadRun(id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(
            manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id} (not running)`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const structuredOutputEnabled = isWorkflowStructuredOutputEnabled(opts.cwd ?? process.cwd());
          const ok = await manager.resume(id, {
            hostRetryPolicy: readRequiredHostRetryPolicy(ctx),
            structuredOutputEnabled,
          });
          ctx.ui.notify(ok ? `Resumed ${id}` : `Resume not available for ${id} yet`, ok ? "info" : "warning");
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const result = await manager.deleteRun(id);
          ctx.ui.notify(
            result === "deleted"
              ? `Removed ${id}`
              : result === "leased"
                ? `Cannot remove ${id} (run is active)`
                : `No run ${id}`,
            result === "deleted" ? "info" : "warning",
          );
          return;
        }
        case "save": {
          const name = id;
          if (!name)
            return ctx.ui.notify("Usage: /workflow save <name> [runId] [--project|--global] [--replace]", "warning");
          if (!opts.storage) return ctx.ui.notify("Saving is not available (no storage configured)", "error");
          const storage = opts.storage;
          const runs = manager.listRuns();
          const runIdArg = parts.slice(2).find((part) => !part.startsWith("--"));
          const parsedScope = parseSavedScope(parts.slice(2));
          if (parsedScope.error) return ctx.ui.notify(parsedScope.error, "warning");
          const location = (parsedScope.scope as "project" | "global" | undefined) ?? "project";
          if (!parts.includes("--replace") && storage.load(name, location)) {
            ctx.ui.notify(
              `Saved workflow "@${name}" already exists in ${location}; pass --replace to overwrite it`,
              "warning",
            );
            return;
          }
          // Pick the named run, else the most recent run that still has its script.
          const summary = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.hasScript);
          const run = summary ? manager.loadRun(summary.runId) : null;
          if (!run?.script) {
            ctx.ui.notify(runIdArg ? `No run ${runIdArg} with a script` : "No saved run to save", "error");
            return;
          }
          let saved: ReturnType<WorkflowStorage["save"]>;
          try {
            saved = storage.save(
              {
                name,
                description: run.workflowName,
                script: run.script,
                location,
              },
              location,
            );
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          ctx.ui.notify(`Saved @${name} [${saved.location}] (from ${run.runId})`, "info");
          return;
        }
        case "show": {
          const name = savedName(id);
          if (!name) return ctx.ui.notify("Usage: /workflow show @name [--project|--global]", "warning");
          const parsedScope = parseSavedScope(parts.slice(2));
          if (parsedScope.error) return ctx.ui.notify(parsedScope.error, "warning");
          const saved = opts.storage?.load(name, parsedScope.scope as "project" | "global" | undefined);
          if (!saved) return ctx.ui.notify(`No saved workflow "@${name}"`, "error");
          await print(renderSavedWorkflow(saved));
          return;
        }
        case "delete": {
          const name = savedName(id);
          if (!name) return ctx.ui.notify("Usage: /workflow delete @name [--project|--global]", "warning");
          const parsedScope = parseSavedScope(parts.slice(2));
          if (parsedScope.error) return ctx.ui.notify(parsedScope.error, "warning");
          const scope = parsedScope.scope as "project" | "global" | undefined;
          const saved = opts.storage?.load(name, scope);
          if (!saved) return ctx.ui.notify(`No saved workflow "@${name}"`, "error");
          const deleted = opts.storage?.delete(name, saved.location) === true;
          ctx.ui.notify(
            deleted ? `Deleted @${name} [${saved.location}]` : `Could not delete @${name}`,
            deleted ? "info" : "error",
          );
          return;
        }
        case "model": {
          await ctx.waitForIdle();
          await openWorkflowModelEditor(ctx);
          return;
        }
        case "trigger": {
          if (!opts.modeState) return ctx.ui.notify("Workflow trigger settings are unavailable", "error");
          await handleWorkflowTriggerCommand(pi, opts.modeState, parts.slice(1).join(" "), ctx, opts.settingsStore);
          return;
        }
        case "progress": {
          await handleWorkflowProgressCommand(pi, parts.slice(1).join(" "), ctx, opts.settingsStore);
          return;
        }
        case "prompt": {
          await handleWorkflowMainPromptCommand(pi, parts.slice(1).join(" "), ctx);
          return;
        }
        case "intensity": {
          if (!opts.intensity) return ctx.ui.notify("Workflow intensity is unavailable", "error");
          await handleWorkflowIntensityCommand(pi, opts.intensity, parts.slice(1).join(" "), ctx);
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
      }
    },
  });
}
