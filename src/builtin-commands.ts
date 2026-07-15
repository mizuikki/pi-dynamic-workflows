/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`,
 * `/multi-perspective`, `/code-review`, and `/codebase-audit`.
 * They run a generated workflow script and print the final report.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCodingTools,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
import { generateCodeReviewWorkflow, MAX_DIFF_CHARS } from "./code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
import { createWebTools } from "./web-tools.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";

const execFileAsync = promisify(execFile);

/**
 * Cap on the diff-source exec's stdout+stderr buffer. Node's default (1 MB)
 * throws on anything but a small diff — `gh pr diff` on a sizeable PR routinely
 * exceeds it. 64 MB comfortably covers any realistic diff while still bounding
 * worst-case memory; the prompt-side cap (code-review.ts's MAX_DIFF_CHARS) is
 * what actually protects the review from a huge diff, not this buffer.
 */
const DIFF_EXEC_MAX_BUFFER = 64 * 1024 * 1024;

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

/** Split a command argument string into tokens, respecting single/double quotes. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

const MAX_BUILTIN_COMMAND_ITEMS = 10;

function capCommandItems(items: string[], label: string, ctx: ExtensionCommandContext): string[] {
  if (items.length <= MAX_BUILTIN_COMMAND_ITEMS) return items;
  ctx.ui.notify(
    `Using the first ${MAX_BUILTIN_COMMAND_ITEMS} ${label}; ${items.length - MAX_BUILTIN_COMMAND_ITEMS} extra ${label} omitted.`,
    "warning",
  );
  return items.slice(0, MAX_BUILTIN_COMMAND_ITEMS);
}

function currentModelSpec(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function syncManagerFromContext(pi: ExtensionAPI, manager: WorkflowManager, ctx: ExtensionCommandContext): void {
  manager.setSessionOptions({ modelRegistry: ctx.modelRegistry, model: ctx.model });
  manager.setModelRegistry(ctx.modelRegistry);
  manager.setMainModel(currentModelSpec(ctx));
  manager.setThinkingLevel(pi.getThinkingLevel());
  try {
    manager.setSessionId(ctx.sessionManager?.getSessionId());
  } catch {
    // Headless command contexts may not expose a session manager.
  }
}

async function runBuiltinWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  script: string,
  args: unknown,
  options: {
    cwd: string;
    tools: ToolDefinition[];
    manager?: WorkflowManager;
    onPhase: (title: string) => void;
  },
): Promise<WorkflowRunResult> {
  if (options.manager) {
    syncManagerFromContext(pi, options.manager, ctx);
    return options.manager.runSync(script, args, { tools: options.tools, onPhase: options.onPhase });
  }
  return runWorkflow(script, {
    cwd: options.cwd,
    args,
    tools: options.tools,
    session: { modelRegistry: ctx.modelRegistry, model: ctx.model },
    modelRegistry: ctx.modelRegistry,
    mainModel: currentModelSpec(ctx),
    currentThinkingLevel: pi.getThinkingLevel(),
    onPhase: options.onPhase,
  });
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

export function registerBuiltinWorkflows(pi: ExtensionAPI, opts: { cwd: string; manager?: WorkflowManager }): void {
  const cwd = opts.cwd;

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const question = args.trim();
        if (!question) return ctx.ui.notify("Usage: /deep-research <question>", "warning");
        ctx.ui.notify("Researching — running web searches across several angles…", "info");
        try {
          const result = await runBuiltinWorkflow(
            pi,
            ctx,
            generateDeepResearchWorkflow(),
            { question },
            {
              cwd,
              tools: [...createCodingTools(cwd), ...createWebTools()],
              manager: opts.manager,
              onPhase: (title) => ctx.ui.setStatus("deep-research", `research: ${title}`),
            },
          );
          ctx.ui.setStatus("deep-research", undefined);
          await pi.sendMessage({ customType: "deep-research", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("deep-research", undefined);
          ctx.ui.notify(`deep-research failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "Investigate a task, then cross-check each finding with skeptical reviewers",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const task = args.trim();
        if (!task) return ctx.ui.notify("Usage: /adversarial-review <task or question>", "warning");
        ctx.ui.notify("Reviewing — investigating then refuting each finding…", "info");
        try {
          const result = await runBuiltinWorkflow(
            pi,
            ctx,
            generateAdversarialReviewWorkflow(),
            { task },
            {
              cwd,
              tools: createCodingTools(cwd),
              manager: opts.manager,
              onPhase: (title) => ctx.ui.setStatus("adversarial-review", `review: ${title}`),
            },
          );
          ctx.ui.setStatus("adversarial-review", undefined);
          await pi.sendMessage({ customType: "adversarial-review", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("adversarial-review", undefined);
          ctx.ui.notify(`adversarial-review failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "code-review")) {
    pi.registerCommand("code-review", {
      description:
        "Multi-angle parallel code review: 7 specialized finders (correctness, reuse, simplification, efficiency, altitude) + verify pass → ranked findings",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const input = args.trim();
        let diffSource = "git diff HEAD";
        let diff = "";

        try {
          let cmd: string;
          let cmdArgs: string[];
          if (!input) {
            diffSource = "git diff HEAD";
            cmd = "git";
            cmdArgs = ["diff", "HEAD"];
          } else if (/^\d+$/.test(input)) {
            diffSource = `gh pr diff ${input}`;
            cmd = "gh";
            cmdArgs = ["pr", "diff", input];
          } else if (input.includes("..")) {
            diffSource = `git diff ${input}`;
            cmd = "git";
            cmdArgs = ["diff", input];
          } else {
            diffSource = `git diff HEAD -- ${input}`;
            cmd = "git";
            cmdArgs = ["diff", "HEAD", "--", input];
          }
          // execFile (not exec/shell) + array args: input can't break out into a
          // shell command. maxBuffer raised well past Node's 1MB default so a
          // large `gh pr diff` doesn't throw ERR_CHILD_PROCESS_STDOUT_MAXBUFFER.
          const { stdout } = await execFileAsync(cmd, cmdArgs, { cwd, maxBuffer: DIFF_EXEC_MAX_BUFFER });
          diff = stdout;
          if (!diff.trim()) {
            return ctx.ui.notify(`No diff output from: ${diffSource}`, "warning");
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
            return ctx.ui.notify(
              `Diff from ${diffSource} exceeds the ${Math.floor(DIFF_EXEC_MAX_BUFFER / (1024 * 1024))}MB capture limit — ` +
                `narrow the target (e.g. a specific file or path) and try again.`,
              "error",
            );
          }
          return ctx.ui.notify(
            `Failed to get diff (${diffSource}): ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }

        // The workflow itself also caps prompt size (MAX_DIFF_CHARS), but truncating
        // here lets us tell the user clearly rather than have it happen silently deep
        // inside the generated script.
        const originalLength = diff.length;
        if (originalLength > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS);
          ctx.ui.notify(
            `Diff is ${originalLength.toLocaleString()} characters — truncated to the first ` +
              `${MAX_DIFF_CHARS.toLocaleString()} for the review. Findings past the cut are not covered.`,
            "warning",
          );
        }

        ctx.ui.notify(`Reviewing diff (${diffSource}) — running 7 finder angles in parallel…`, "info");
        try {
          const result = await runBuiltinWorkflow(
            pi,
            ctx,
            generateCodeReviewWorkflow(),
            { diff, diffSource },
            {
              cwd,
              tools: createCodingTools(cwd),
              manager: opts.manager,
              onPhase: (title) => ctx.ui.setStatus("code-review", `review: ${title}`),
            },
          );
          ctx.ui.setStatus("code-review", undefined);
          await pi.sendMessage({ customType: "code-review", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("code-review", undefined);
          ctx.ui.notify(`code-review failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "multi-perspective")) {
    pi.registerCommand("multi-perspective", {
      description: "Analyze a topic from several independent perspectives in parallel, then synthesize",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const [topic, ...rest] = tokenizeArgs(args);
        if (!topic) {
          return ctx.ui.notify('Usage: /multi-perspective "<topic>" [perspective1] [perspective2] …', "warning");
        }
        // Fall back to a broadly-useful default set when fewer than two are given.
        const perspectives =
          rest.length >= 2
            ? capCommandItems(rest, "perspectives", ctx)
            : ["technical", "product", "security", "user experience", "maintainability"];
        ctx.ui.notify(`Analyzing from ${perspectives.length} perspectives…`, "info");
        try {
          const result = await runBuiltinWorkflow(
            pi,
            ctx,
            generateMultiPerspectiveWorkflow(topic, perspectives),
            undefined,
            {
              cwd,
              tools: createCodingTools(cwd),
              manager: opts.manager,
              onPhase: (title) => ctx.ui.setStatus("multi-perspective", `perspectives: ${title}`),
            },
          );
          ctx.ui.setStatus("multi-perspective", undefined);
          // This workflow returns its prose under `synthesis`, not `report`.
          const r = result.result as { synthesis?: unknown } | undefined;
          const content = r && typeof r.synthesis === "string" && r.synthesis.trim() ? r.synthesis : reportText(result);
          await pi.sendMessage({ customType: "multi-perspective", content, display: true });
        } catch (error) {
          ctx.ui.setStatus("multi-perspective", undefined);
          ctx.ui.notify(`multi-perspective failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "codebase-audit")) {
    pi.registerCommand("codebase-audit", {
      description: "Run parallel checks against a codebase scope, then cross-validate and report",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const [scope, ...checks] = tokenizeArgs(args);
        if (!scope || checks.length === 0) {
          return ctx.ui.notify('Usage: /codebase-audit <scope> "<check1>" ["<check2>" …]', "warning");
        }
        const cappedChecks = capCommandItems(checks, "checks", ctx);
        ctx.ui.notify(`Auditing ${scope} across ${cappedChecks.length} checks…`, "info");
        try {
          const result = await runBuiltinWorkflow(
            pi,
            ctx,
            generateCodebaseAuditWorkflow(scope, cappedChecks),
            undefined,
            {
              cwd,
              tools: createCodingTools(cwd),
              manager: opts.manager,
              onPhase: (title) => ctx.ui.setStatus("codebase-audit", `audit: ${title}`),
            },
          );
          ctx.ui.setStatus("codebase-audit", undefined);
          await pi.sendMessage({ customType: "codebase-audit", content: reportText(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("codebase-audit", undefined);
          ctx.ui.notify(`codebase-audit failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }
}
