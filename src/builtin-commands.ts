/**
 * Bundled workflow commands: `/deep-research` and `/adversarial-review`.
 * They run a generated workflow script and print the final report.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow } from "./adversarial-review.js";
import { generateDeepResearchWorkflow } from "./deep-research.js";
import { createCodingTools } from "./pi-coding-agent-sdk.js";
import { createWebTools } from "./web-tools.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

function currentModelSpec(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function syncManagerFromContext(pi: ExtensionAPI, manager: WorkflowManager, ctx: ExtensionCommandContext): void {
  manager.setSessionOptions({ modelRegistry: ctx.modelRegistry, model: ctx.model });
  manager.setMainModel(currentModelSpec(ctx));
  manager.setThinkingLevel(pi.getThinkingLevel());
  manager.setSessionId(ctx.sessionManager.getSessionId());
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
    return options.manager.runSync(script, args, {
      tools: options.tools,
      onPhase: options.onPhase,
    });
  }

  return runWorkflow(script, {
    cwd: options.cwd,
    args,
    tools: options.tools,
    session: {
      modelRegistry: ctx.modelRegistry,
      model: ctx.model,
    },
    mainModel: currentModelSpec(ctx),
    currentThinkingLevel: pi.getThinkingLevel(),
    onPhase: options.onPhase,
  });
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
}
