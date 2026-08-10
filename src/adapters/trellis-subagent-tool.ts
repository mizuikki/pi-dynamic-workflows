/**
 * Optional host-facing `trellis_subagent` tool for Pi Workflow Orchestrator.
 *
 * Dispatches single/parallel/chain runs through the shared WorkflowAgent runtime
 * with Trellis task context. Does NOT own Trellis lifecycle (create/start/archive).
 * Registers only when the adapter is enabled and no native Trellis tool is present.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkflowAgent } from "../agent.js";
import type { AgentHistoryEntry } from "../agent-history.js";
import { parseAgentDefinition } from "../agent-registry.js";
import { mergeSubagentEnv, type SubagentContextLoader } from "../subagent-context.js";
import {
  buildTrellisTaskContext,
  normalizeTrellisAgentName,
  parseActiveTaskLine,
  readTrellisAgentDefinition,
  resolveActiveTaskPath,
  resolveTrellisContextKey,
  type TrellisAdapterSettings,
  type TrellisContextLoaderOptions,
  toRepoRelativePath,
} from "./trellis.js";

export const TRELLIS_SUBAGENT_TOOL_NAME = "trellis_subagent";
export const MAX_TRELLIS_PARALLEL_PROMPTS = 6;

const THINKING_ENUM = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_ENUM as readonly string[]).includes(value);
}

const trellisSubagentSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Agent name, such as trellis-implement or trellis-check.",
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Task prompt for the sub-agent (single mode)." })),
  mode: Type.Optional(
    Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")], {
      description: "Dispatch mode. Default single.",
    }),
  ),
  prompts: Type.Optional(
    Type.Array(Type.String(), {
      description: "Prompts for parallel/chain modes (max 6).",
      maxItems: MAX_TRELLIS_PARALLEL_PROMPTS,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional Pi model override for the child sub-agent (provider/id[:thinking]).",
    }),
  ),
  thinking: Type.Optional(
    Type.Union(
      THINKING_ENUM.map((level) => Type.Literal(level)),
      { description: "Optional Pi thinking level override for the child sub-agent." },
    ),
  ),
});

export type TrellisSubagentMode = "single" | "parallel" | "chain";

export type TrellisSubagentToolInput = {
  agent?: string;
  prompt?: string;
  mode?: TrellisSubagentMode;
  prompts?: string[];
  model?: string;
  thinking?: (typeof THINKING_ENUM)[number];
};

export type TrellisSubagentRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TrellisSubagentRunDetails = {
  id: string;
  agent: string;
  prompt: string;
  status: TrellisSubagentRunStatus;
  step?: number;
  finalText?: string;
  errorMessage?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    cost?: number;
  };
};

export type TrellisSubagentProgressDetails = {
  kind: "trellis-subagent-progress";
  mode: TrellisSubagentMode;
  agent: string;
  startedAt: number;
  updatedAt: number;
  final: boolean;
  runs: TrellisSubagentRunDetails[];
};

export interface TrellisSubagentToolOptions {
  cwd: string;
  /** Bound WorkflowAgent (or compatible runner) for child sessions. */
  agent: Pick<WorkflowAgent, "run">;
  /** Context loader (typically createTrellisContextLoader). */
  contextLoader?: SubagentContextLoader;
  /** Host session id for context key + loader. */
  getSessionId?: () => string | undefined;
  /** Host transcript path fallback for native Trellis context identity. */
  getSessionFile?: () => string | undefined;
  /** Host project trust flag. */
  getProjectTrusted?: () => boolean | undefined;
  /** Host thinking level when tool input omits thinking. */
  getThinkingLevel?: () => string | undefined;
  /** Adapter settings (autoPrepend etc.). */
  settings?: TrellisAdapterSettings;
  /** Optional task.py current override for tests. */
  resolveTaskPyCurrent?: TrellisContextLoaderOptions["resolveTaskPyCurrent"];
  /** Warning sink. */
  warn?: (message: string) => void;
}

/**
 * Detect an already-registered `trellis_subagent` tool via the public ExtensionAPI.
 * Fail closed (return true = "already present / skip") when getAllTools is unavailable
 * or throws (e.g. pre-bind notInitialized).
 */
export function hasRegisteredTrellisSubagentTool(pi: Pick<ExtensionAPI, "getAllTools">): boolean {
  try {
    const tools = pi.getAllTools();
    if (!Array.isArray(tools)) return true;
    return tools.some((tool) => tool?.name === TRELLIS_SUBAGENT_TOOL_NAME);
  } catch {
    return true;
  }
}

function notTrellisAgentText(agentName: string): string {
  return (
    "`trellis_subagent` is only for Trellis workflow agents with a definition file in .pi/agents/.\n\n" +
    `No definition found for: ${agentName}\n\n` +
    "For general-purpose sub-agents, use one of these community tools:\n" +
    "- `subagent` tool from npm:pi-subagents (nicobailon/pi-subagents)\n" +
    "- `Agent` tool from npm:@tintinweb/pi-subagents\n\n" +
    "If neither is installed, ask the user to either:\n" +
    `- Create .pi/agents/${agentName}.md for your custom Trellis agent\n` +
    "- Install a community subagent package: pi install -l npm:@tintinweb/pi-subagents"
  );
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 4).trim();
}

function buildDelegatedPrompt(
  cwd: string,
  agentName: string,
  agentDefinition: string,
  delegatedTask: string,
  taskDir?: string,
): string {
  const agentBody = stripFrontmatter(agentDefinition);
  const taskContext = taskDir
    ? buildTrellisTaskContext(cwd, taskDir, agentName)
    : ["## Trellis Task Context", "Task directory: (unresolved)", "", "### prd.md", "(missing)"].join("\n");
  return [
    "## Trellis Agent Definition",
    agentBody || "(missing)",
    "",
    taskContext,
    "",
    "## Delegated Task",
    delegatedTask,
  ].join("\n");
}

function historyTail(history: AgentHistoryEntry[] | undefined, max = 400): string | undefined {
  if (!history?.length) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.role === "assistant" && entry.text?.trim()) {
      const text = entry.text.trim();
      return text.length > max ? `${text.slice(0, max)}…` : text;
    }
  }
  return undefined;
}

const MODEL_THINKING_SUFFIX = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/i;

function normalizeThinking(value: string | undefined): ModelThinkingLevel | undefined {
  const candidate = value?.trim().toLowerCase();
  return candidate && isThinkingLevel(candidate) ? candidate : undefined;
}

function splitModelThinking(model: string | undefined): {
  model: string | undefined;
  thinking: ModelThinkingLevel | undefined;
} {
  const candidate = model?.trim() || undefined;
  const match = candidate?.match(MODEL_THINKING_SUFFIX);
  return {
    model: (match?.[1] || candidate)?.trim() || undefined,
    thinking: normalizeThinking(match?.[2]),
  };
}

function resolveRunModelAndThinking(
  inputModel: string | undefined,
  inputThinking: string | undefined,
  agentModel: string | undefined,
  agentThinking: string | undefined,
  hostThinking: string | undefined,
): { model: string | undefined; thinkingLevel: ModelThinkingLevel | undefined } {
  const input = splitModelThinking(inputModel);
  const agent = splitModelThinking(agentModel);
  return {
    model: input.model ?? agent.model,
    thinkingLevel:
      normalizeThinking(inputThinking) ??
      input.thinking ??
      normalizeThinking(agentThinking) ??
      agent.thinking ??
      normalizeThinking(hostThinking),
  };
}

/**
 * Create the host `trellis_subagent` tool definition.
 * Callers must gate registration with shouldRegisterTrellisSubagentTool + hasRegisteredTrellisSubagentTool.
 */
export function createTrellisSubagentTool(
  options: TrellisSubagentToolOptions,
): ToolDefinition<typeof trellisSubagentSchema, TrellisSubagentProgressDetails> {
  const cwd = options.cwd;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const autoPrepend = options.settings?.autoPrependActiveTaskLine !== false;

  return defineTool({
    name: TRELLIS_SUBAGENT_TOOL_NAME,
    label: "Trellis Subagent",
    description: "Run a Trellis project sub-agent with active task context.",
    promptSnippet:
      'Sub-agent dispatch protocol (Trellis): your dispatch prompt MUST start with one line "Active task: <task path from `task.py current`>" before any other instructions.',
    promptGuidelines: [
      'Use subagent for task delegation. Your dispatch prompt MUST start with "Active task: <task path from `task.py current`>".',
    ],
    parameters: trellisSubagentSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentName = normalizeTrellisAgentName(params.agent);
      const agentDefinition = readTrellisAgentDefinition(cwd, agentName);
      if (agentDefinition === undefined) {
        return {
          content: [{ type: "text", text: notTrellisAgentText(agentName) }],
          details: {
            kind: "trellis-subagent-progress",
            mode: (params.mode ?? "single") as TrellisSubagentMode,
            agent: agentName,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            final: true,
            runs: [],
          },
          isError: true,
        };
      }

      const mode: TrellisSubagentMode = params.mode ?? "single";
      const prompt = params.prompt?.trim();
      const prompts = params.prompts?.map((p) => p.trim()).filter(Boolean);
      if (mode === "single" && !prompt) {
        throw new Error("subagent prompt is required for single mode");
      }
      if ((mode === "parallel" || mode === "chain") && !prompt && !prompts?.length) {
        throw new Error("subagent prompt or prompts are required for parallel/chain mode");
      }
      if (mode === "parallel" && prompts && prompts.length > MAX_TRELLIS_PARALLEL_PROMPTS) {
        throw new Error(`subagent parallel mode supports at most ${MAX_TRELLIS_PARALLEL_PROMPTS} prompts`);
      }

      const sessionId =
        options.getSessionId?.() ??
        (() => {
          try {
            const manager = (ctx as ExtensionContext | undefined)?.sessionManager;
            return manager?.getSessionId?.call(manager);
          } catch {
            return undefined;
          }
        })();
      const sessionFile =
        options.getSessionFile?.() ??
        (() => {
          try {
            const manager = (ctx as ExtensionContext | undefined)?.sessionManager;
            return manager?.getSessionFile?.call(manager);
          } catch {
            return undefined;
          }
        })();

      const agentDef = parseAgentDefinition(agentDefinition, "project", `${agentName}.md`) ?? undefined;
      // Hard shared-cwd for implement/check: ignore worktree isolation from the def.
      const forceSharedCwd =
        agentName === "trellis-implement" ||
        agentName === "trellis-check" ||
        agentName === "implement" ||
        agentName === "check";

      const { model, thinkingLevel } = resolveRunModelAndThinking(
        params.model,
        params.thinking,
        agentDef?.model,
        agentDef?.thinking,
        options.getThinkingLevel?.(),
      );
      // Host trust is consumed by the bound WorkflowAgent constructor (extension
      // wiring rebuilds the runner with projectTrusted). Keep the getter live so
      // custom hosts can observe it; prefer constructor inheritance over per-run.
      const projectTrusted = options.getProjectTrusted?.();
      void projectTrusted;
      void ctx;

      const contextKey = resolveTrellisContextKey(cwd, sessionId, { sessionFile });
      const loaderOptions: TrellisContextLoaderOptions = {
        enabled: "on",
        autoPrependActiveTaskLine: autoPrepend,
        resolveTaskPyCurrent: options.resolveTaskPyCurrent,
        getSessionFile: () => sessionFile,
        warn,
      };

      const startedAt = Date.now();
      const details: TrellisSubagentProgressDetails = {
        kind: "trellis-subagent-progress",
        mode,
        agent: agentName,
        startedAt,
        updatedAt: startedAt,
        final: false,
        runs: [],
      };

      let lastEmit = 0;
      const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 250) return;
        lastEmit = now;
        details.updatedAt = now;
        onUpdate?.({
          content: [{ type: "text", text: summarizeProgress(details) }],
          details: cloneDetails(details),
        });
      };

      const resolveTaskDirForPrompt = (delegated: string) =>
        resolveActiveTaskPath(cwd, delegated, sessionId, loaderOptions, warn);

      const runOne = async (
        run: TrellisSubagentRunDetails,
        delegatedTask: string,
      ): Promise<{ output: string; failed: boolean }> => {
        if (signal?.aborted) {
          run.status = "cancelled";
          run.errorMessage = "cancelled";
          emit(true);
          return { output: "cancelled", failed: true };
        }

        run.status = "running";
        emit(true);

        // Ensure Active task line is present when we can resolve a path.
        let taskPrompt = delegatedTask;
        const taskDir = resolveTaskDirForPrompt(delegatedTask);
        if (autoPrepend && taskDir && !parseActiveTaskLine(taskPrompt)) {
          const relTask = toRepoRelativePath(cwd, taskDir);
          if (relTask) {
            taskPrompt = `Active task: ${relTask}\n${delegatedTask}`;
          }
        }

        // Pre-build the full prompt so context participates even when loader is skipped later.
        // Still pass contextLoader so env (TRELLIS_CONTEXT_ID) is applied by the runner.
        const fullPrompt = buildDelegatedPrompt(cwd, agentName, agentDefinition, taskPrompt, taskDir);
        const contextLoader: SubagentContextLoader = async (args) => {
          const base = options.contextLoader ? await options.contextLoader(args) : undefined;
          const key = contextKey ?? resolveTrellisContextKey(args.cwd, args.sessionId, { sessionFile });
          const env = key ? { TRELLIS_CONTEXT_ID: key } : undefined;
          // Prompt already includes task context; only inject env (+ optional instructions).
          return {
            instructions: base?.instructions,
            env: mergeSubagentEnv(base?.env, env),
          };
        };

        try {
          const text = await options.agent.run(fullPrompt, {
            label: run.id,
            agentType: agentName,
            model,
            thinkingLevel,
            toolNames: agentDef?.tools,
            disallowedToolNames: agentDef?.disallowedTools,
            // Shared project cwd for implement/check — never inherit worktree isolation.
            ...(forceSharedCwd ? { cwd } : {}),
            signal,
            contextLoader,
            sessionId,
            // Agent body already in fullPrompt; avoid double body via instructions from def.
            instructions: undefined,
            onHistory: (history) => {
              const tail = historyTail(history);
              if (tail) run.finalText = tail;
              emit();
            },
            onUsage: (usage) => {
              run.usage = {
                input: usage.input,
                output: usage.output,
                total: usage.total,
                cost: usage.cost,
              };
            },
            onModelResolved: (id) => {
              run.model = id;
            },
          });

          if (signal?.aborted) {
            run.status = "cancelled";
            run.errorMessage = "cancelled";
            emit(true);
            return { output: "cancelled", failed: true };
          }

          const output = typeof text === "string" ? text : JSON.stringify(text);
          run.status = "completed";
          run.finalText = output;
          emit(true);
          return { output, failed: false };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const cancelled = signal?.aborted || /abort/i.test(message);
          run.status = cancelled ? "cancelled" : "failed";
          run.errorMessage = message;
          run.finalText = message;
          emit(true);
          return { output: message, failed: true };
        }
      };

      try {
        if (mode === "parallel") {
          const list = prompts?.length ? prompts : prompt ? [prompt] : [];
          details.runs = list.map((p, i) => ({
            id: `${agentName}-${i + 1}`,
            agent: agentName,
            prompt: p,
            status: "pending" as const,
          }));
          emit(true);
          const results = await Promise.all(details.runs.map((run, i) => runOne(run, list[i] ?? "")));
          details.final = true;
          details.updatedAt = Date.now();
          emit(true);
          const failed = results.some((r) => r.failed);
          const text = results.map((r) => r.output).join("\n\n---\n\n");
          return {
            content: [{ type: "text", text }],
            details: cloneDetails(details),
            isError: failed,
          };
        }

        if (mode === "chain") {
          const list = prompts?.length ? prompts : prompt ? [prompt] : [];
          let prev = "";
          let failed = false;
          for (let i = 0; i < list.length; i++) {
            const p = list[i] ?? "";
            const run: TrellisSubagentRunDetails = {
              id: `${agentName}-${i + 1}`,
              agent: agentName,
              prompt: p,
              status: "pending",
              step: i + 1,
            };
            details.runs.push(run);
            emit(true);
            const delegated = prev ? `${p}\n\nPrevious output:\n${prev}` : p;
            const result = await runOne(run, delegated);
            prev = result.output;
            failed = failed || result.failed;
            if (result.failed) break;
          }
          details.final = true;
          details.updatedAt = Date.now();
          emit(true);
          return {
            content: [{ type: "text", text: prev }],
            details: cloneDetails(details),
            isError: failed,
          };
        }

        // single
        const run: TrellisSubagentRunDetails = {
          id: `${agentName}-1`,
          agent: agentName,
          prompt: prompt ?? "",
          status: "pending",
        };
        details.runs = [run];
        emit(true);
        const result = await runOne(run, prompt ?? "");
        details.final = true;
        details.updatedAt = Date.now();
        emit(true);
        return {
          content: [{ type: "text", text: result.output }],
          details: cloneDetails(details),
          isError: result.failed,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const active = details.runs.find((r) => r.status === "running") ?? details.runs[details.runs.length - 1];
        if (active) {
          active.status = "failed";
          active.errorMessage = message;
        }
        details.final = true;
        details.updatedAt = Date.now();
        emit(true);
        return {
          content: [{ type: "text", text: message }],
          details: cloneDetails(details),
          isError: true,
        };
      }
    },
  });
}

function summarizeProgress(details: TrellisSubagentProgressDetails): string {
  const parts = details.runs.map((run) => {
    const icon =
      run.status === "completed"
        ? "✓"
        : run.status === "failed"
          ? "✗"
          : run.status === "cancelled"
            ? "⊘"
            : run.status === "running"
              ? "…"
              : "·";
    return `${icon} ${run.id} (${run.status})`;
  });
  return `trellis_subagent ${details.mode} ${details.agent}: ${parts.join(" | ") || "starting"}`;
}

function cloneDetails(details: TrellisSubagentProgressDetails): TrellisSubagentProgressDetails {
  return {
    ...details,
    runs: details.runs.map((run) => ({ ...run, usage: run.usage ? { ...run.usage } : undefined })),
  };
}
