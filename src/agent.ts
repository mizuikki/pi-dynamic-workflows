import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, isRetryableAssistantError, type Model, type TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  type Extension,
  getAgentDir,
  type LoadExtensionsResult,
  type ModelRegistry,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { KeelPiInvocationV1 } from "./keel-host-contract.js";
import {
  copyRegisteredProviders,
  createPluginModelRuntime,
  type ModelListSource,
  modelListFromRegistry,
  modelListFromRuntime,
} from "./model-runtime.js";
import {
  canonicalModelSpec,
  type ModelThinkingLevel,
  resolveRegisteredModel,
  validateModelEffort,
} from "./model-selection.js";
import {
  listAvailableModelSpecsAsync as listAvailableModelSpecsAsyncCompat,
  listAvailableModelSpecs as listAvailableModelSpecsCompat,
  type ModelAvailabilitySource,
} from "./pi-compat.js";
import {
  type AgentTurnRetryOverride,
  childRetrySettings,
  type ImmutableHostRetryPolicySnapshot,
} from "./retry-policy.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import {
  applySubagentContext,
  mergeSubagentEnv,
  prependEnvExports,
  type SubagentContext,
  type SubagentContextLoader,
} from "./subagent-context.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

const WORKFLOW_EXTENSION_SUFFIXES = [
  "extensions/workflow.ts",
  "extensions/workflow.js",
  "extensions/workflow.mjs",
  "extensions/workflow.cjs",
] as const;

export type ExtensionPathFilter = (pathValue: string) => boolean;

function shouldFilterWorkflowExtensionPath(pathValue: string): boolean {
  const normalized = pathValue.replace(/\\/g, "/").toLowerCase();
  return WORKFLOW_EXTENSION_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function extensionPathValues(extension: { path: string; resolvedPath?: string }): string[] {
  return [extension.path, extension.resolvedPath].filter((pathValue): pathValue is string => Boolean(pathValue));
}

/**
 * The workflow extension is normally identified by its path. Inline extension
 * factories have synthetic paths, so use the feature's own tool/command names
 * as provenance-independent identity checks for child sessions. The tool check
 * also covers a host command collision where command registration is skipped.
 */
function isWorkflowPolicyExtension(extension: Extension): boolean {
  return extension.tools?.has("workflow") === true || extension.commands?.has("workflows-prompt") === true;
}

function configuredFilterMatches(pathValues: string[], filters: ExtensionPathFilter[]): boolean {
  return filters.some((filter) => pathValues.some((pathValue) => filter(pathValue)));
}

function isCodexAdaptorExtension(extension: Extension): boolean {
  return extensionPathValues(extension).some((pathValue) =>
    pathValue.replace(/\\/g, "/").toLowerCase().includes("/pi-codex-adaptor/"),
  );
}

function includeProviderProfileTools(
  allowlist: string[] | undefined,
  extensions: readonly Extension[],
): string[] | undefined {
  if (!allowlist) return undefined;
  const result = new Set(allowlist);
  for (const extension of extensions) {
    if (!isCodexAdaptorExtension(extension)) continue;
    for (const name of extension.tools.keys()) result.add(name);
  }
  return [...result];
}

function filterExtensions(
  result: LoadExtensionsResult,
  extraFilters: ExtensionPathFilter[] = [],
): LoadExtensionsResult {
  const shouldDrop = (pathValues: string[]) =>
    pathValues.some((pathValue) => shouldFilterWorkflowExtensionPath(pathValue)) ||
    configuredFilterMatches(pathValues, extraFilters);
  return {
    ...result,
    extensions: result.extensions.filter(
      (extension) => !isWorkflowPolicyExtension(extension) && !shouldDrop(extensionPathValues(extension)),
    ),
    errors: result.errors.filter((error) => {
      const errorWithResolvedPath = error as { path: string; resolvedPath?: string };
      return !shouldDrop(extensionPathValues(errorWithResolvedPath));
    }),
  };
}

/** True only for explicit child-process markers used by supported launchers. */
export function isKnownTrellisChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRELLIS_SUBAGENT_CHILD === "1" || env.PI_DYNAMIC_WORKFLOWS_CHILD === "1";
}

export interface WrapResourceLoaderOptions {
  /** Additional path predicates that drop host extensions from child sessions. */
  extensionPathFilters?: ExtensionPathFilter[];
  /** Per-run environment exported into nested bash calls. */
  env?: Record<string, string>;
}

const SUBAGENT_ENV_EXTENSION_PATH = "<inline:pi-dynamic-workflows-env>";

function rewriteSubagentBashEnv(event: { toolName?: string; input?: unknown }, env: Record<string, string>): void {
  if (event.toolName !== "bash") return;
  const input = event.input as { command?: unknown } | undefined;
  if (!input || typeof input.command !== "string") return;
  input.command = prependEnvExports(input.command, env);
}

function createSubagentEnvExtension(env: Record<string, string>): Extension {
  const snapshot = { ...env };
  const handlers: Extension["handlers"] = new Map();
  handlers.set("tool_call", [
    ((event: { toolName?: string; input?: unknown }) => {
      rewriteSubagentBashEnv(event, snapshot);
    }) as never,
  ]);
  return {
    path: SUBAGENT_ENV_EXTENSION_PATH,
    resolvedPath: SUBAGENT_ENV_EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(SUBAGENT_ENV_EXTENSION_PATH, {
      source: "pi-dynamic-workflows",
    }),
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

/** Keep host resources while preventing workflow.ts from recursively loading itself. */
export function wrapResourceLoaderForWorkflowSubagents(
  resourceLoader: ResourceLoader,
  options: WrapResourceLoaderOptions = {},
): ResourceLoader {
  const extraFilters = options.extensionPathFilters ?? [];
  const envExtension = options.env ? createSubagentEnvExtension(options.env) : undefined;
  return {
    getExtensions: () => {
      const result = filterExtensions(resourceLoader.getExtensions(), extraFilters);
      return envExtension ? { ...result, extensions: [...result.extensions, envExtension] } : result;
    },
    getSkills: () => resourceLoader.getSkills(),
    getPrompts: () => resourceLoader.getPrompts(),
    getThemes: () => resourceLoader.getThemes(),
    getAgentsFiles: () => resourceLoader.getAgentsFiles(),
    getSystemPrompt: () => resourceLoader.getSystemPrompt(),
    getAppendSystemPrompt: () => resourceLoader.getAppendSystemPrompt(),
    extendResources: (paths) => resourceLoader.extendResources(paths),
    reload: (reloadOptions) => resourceLoader.reload(reloadOptions),
  };
}

/**
 * Build an ephemeral inline extension that rewrites child bash commands to export
 * the given env map (e.g. TRELLIS_CONTEXT_ID). Closure-captured per run so parallel
 * agents never cross-contaminate via process.env.
 */
export function createSubagentEnvInterceptorFactory(
  env: Record<string, string>,
): (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void {
  const snapshot = { ...env };
  return (pi) => {
    pi.on("tool_call", (event) => {
      rewriteSubagentBashEnv(event, snapshot);
    });
  };
}

/** Built-in coding-tool names owned by the SDK session (cwd-bound). */
const SDK_BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/**
 * Drop custom tools that only re-provide SDK built-ins. Callers historically
 * passed `createCodingTools(cwd)` as `options.tools`; if those stay as
 * customTools they shadow the session's cwd-bound built-ins and break worktree
 * isolation (tools keep the host cwd). True extras (web tools, SharedStore)
 * are kept.
 */
export function filterShadowingBuiltinCustomTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((tool) => !SDK_BUILTIN_TOOL_NAMES.has(tool.name));
}

/**
 * Resolve the SDK `tools` allowlist for a subagent session.
 * When `toolNames` is set, system/schema tool names are merged so allowlists never
 * strip SharedStore or structured_output. When unset, returns undefined so the SDK
 * default active set is preserved.
 */
export function resolveSessionToolAllowlist(options: {
  toolNames?: string[];
  systemToolNames?: string[];
  includeStructuredOutput?: boolean;
}): string[] | undefined {
  if (!options.toolNames?.length) return undefined;
  const names = new Set(options.toolNames);
  for (const name of options.systemToolNames ?? []) {
    if (name) names.add(name);
  }
  if (options.includeStructuredOutput) names.add("structured_output");
  return [...names];
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

function lastAssistantMessage(messages: unknown[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

/**
 * Preserve a provider terminal error instead of reporting it as an empty
 * response. Capability/profile failures are local configuration errors and
 * cannot be repaired by retrying the same child session.
 */
export function throwIfAssistantError(messages: unknown[], label?: string): void {
  const assistant = lastAssistantMessage(messages);
  if (!assistant || (assistant.stopReason !== "error" && assistant.stopReason !== "aborted")) return;

  const message = assistant.errorMessage ?? "Subagent provider request failed";
  if (assistant.stopReason === "aborted") {
    throw new WorkflowError(message, WorkflowErrorCode.WORKFLOW_ABORTED, {
      recoverable: true,
      agentLabel: label,
    });
  }

  const { matched, resetHint } = classifyProviderLimit(message);
  if (matched) {
    throw new WorkflowError(message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
      recoverable: false,
      agentLabel: label,
      resetHint,
    });
  }
  throw new WorkflowError(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: isRetryableAssistantError(assistant),
    agentLabel: label,
  });
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  throwIfAssistantError(session.messages, options.label);
  if (capture.called) return capture.value as T;

  const maxRetries = options.maxSchemaRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new WorkflowError(
      "maxSchemaRetries must be a non-negative safe integer",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
        agentLabel: options.label,
      },
    );
  }
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
    throwIfAssistantError(session.messages, options.label);
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/** Return the explicit per-agent model, or leave selection to the session. */
export function resolveAgentModelSpec(options: { model?: string }, _mainModel?: string): string | undefined {
  return options.model?.trim() || undefined;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /**
   * Extra custom tools registered for every subagent in addition to SDK built-ins
   * and any per-run tools. Not a base coding-tool set replacement.
   */
  tools?: ToolDefinition[];
  /** Override createAgentSession options other than the top-level modelRuntime. */
  session?: Omit<Partial<CreateAgentSessionOptions>, "modelRuntime">;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /** The session's main model (`provider/modelId`) for display and host fallback. */
  mainModel?: string;
  /**
   * Host extension ModelRegistry facade. Used for model selection and as
   * the source of registered dynamic provider configs to copy into the plugin
   * ModelRuntime. Not passed to createAgentSession.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Plugin-owned execution runtime for child sessions. When omitted, a cached
   * runtime is created asynchronously from agentDir auth/models paths.
   */
  modelRuntime?: ModelRuntime;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory (keyed by the runner's project cwd), instead
   * of the default in-memory session that is discarded when the run ends.
   * Default: false (current behavior).
   */
  persistAgentSessions?: boolean;
  /**
   * Project trust flag forwarded to SettingsManager / resource-loader reload.
   * When omitted, the SDK default (trusted) is preserved.
   */
  projectTrusted?: boolean;
  /** Optional pluggable context loader (e.g. Trellis task context). */
  contextLoader?: SubagentContextLoader;
  /** Session id passed to context loaders (host Pi session when available). */
  sessionId?: string;
  /** Additional extension path filters for child sessions (default: workflow only). */
  extensionPathFilters?: ExtensionPathFilter[];
  /** Immutable host policy sampled once for the owning workflow execution. */
  hostRetryPolicy?: ImmutableHostRetryPolicySnapshot;
  /** Run-level child agent-turn override. */
  agentTurnRetry?: AgentTurnRetryOverride;
  /** Explicit workflow capability snapshot; omitted means structured output is off. */
  structuredOutputEnabled?: boolean;
  /** Create a private child settings manager for each agent execution attempt. */
  settingsManagerFactory?: (options: { cwd: string; agentDir: string; projectTrusted?: boolean }) => SettingsManager;
}

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export type AvailableModelsSource = ModelAvailabilitySource;

export function listAvailableModelSpecs(registry?: ModelAvailabilitySource): string[] {
  return listAvailableModelSpecsCompat(registry);
}

export async function listAvailableModelSpecsAsync(registry?: ModelAvailabilitySource): Promise<string[]> {
  return listAvailableModelSpecsAsyncCompat(registry);
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * Keep a workflow run alive until its child session has acknowledged an abort.
 * `session.abort()` propagates cancellation to the active model/tool operation
 * and resolves only after the session becomes idle. Returning before that point
 * lets a stopped workflow release its bookkeeping while the child can still use
 * the provider connection in the background.
 */
export async function awaitAbortableSubagentPrompt<T>(
  prompt: () => Promise<T>,
  signal: AbortSignal | undefined,
  abort: () => Promise<void>,
): Promise<T> {
  if (!signal) return prompt();

  let abortPromise: Promise<void> | undefined;
  const beginAbort = (): Promise<void> => {
    abortPromise ??= Promise.resolve().then(abort);
    return abortPromise;
  };
  const abortError = () => new Error("Subagent was aborted");

  // Already cancelled before entry: never schedule or invoke prompt.
  if (signal.aborted) {
    await beginAbort();
    throw abortError();
  }

  let rejectWhenAborted: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectWhenAborted = reject;
  });
  const onAbort = () => {
    void beginAbort().then(
      () => rejectWhenAborted?.(abortError()),
      (error) => rejectWhenAborted?.(error),
    );
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await Promise.race([Promise.resolve().then(prompt), aborted]);
    if (!signal.aborted) return result;

    await beginAbort();
    throw abortError();
  } catch (error) {
    if (!signal.aborted) throw error;
    await beginAbort();
    throw abortError();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  /**
   * Display name recorded on the persisted session (session_info entry) when
   * `persistAgentSessions` is enabled, so transcripts are identifiable in
   * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
   * sessions or when an explicit session.sessionManager override is injected.
   */
  sessionName?: string;
  schema?: TSchemaDef;
  /** Explicit workflow capability snapshot; omitted means structured output is off. */
  structuredOutputEnabled?: boolean;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost. `total === 0` means the provider reported no usage.
   */
  onUsage?: (usage: AgentUsage) => void;
  /** Registered `provider/modelId` or unique bare model id for this subagent. */
  model?: string;
  /** Pi-owned reasoning effort for this subagent. */
  effort?: ModelThinkingLevel;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called with the validated Pi-owned effort once known (for display/telemetry). */
  onEffortResolved?: (effort: ModelThinkingLevel) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * enabled structured_output tool is added after this filter, so an enabled
   * schema still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools always registered after the tool-policy filter and protected from
   * `disallowedToolNames` / SDK `excludeTools`. Used by the workflow runtime to
   * inject SharedStore tools into every agent regardless of agentType.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run host ModelRegistry facade for resolution and dynamic provider copy.
   * Takes precedence over the constructor's `modelRegistry`.
   */
  modelRegistry?: ModelRegistry;
  /** Explicit thinking override for this run; otherwise the host setting applies. */
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** Optional per-run context loader override. */
  contextLoader?: SubagentContextLoader;
  /** Optional per-run session id for context loaders. */
  sessionId?: string;
  /** agentType name for context loaders (e.g. Trellis jsonl mapping). */
  agentType?: string;
  /** Validated Keel invocation identity for opt-in host integrations. */
  keelInvocation?: KeelPiInvocationV1;
  /**
   * When true, skip constructor/per-run context loaders. Used when the caller
   * (workflow.ts) already applied context before computing the resume hash.
   */
  skipContextLoading?: boolean;
  /**
   * Per-run environment map for the nested bash interceptor (e.g. TRELLIS_CONTEXT_ID).
   * Preferred over re-loading context when skipContextLoading is true. Never mutates
   * process.env — applied via a per-session tool_call rewrite.
   */
  env?: Record<string, string>;
  /** Per-agent child agent-turn retry override. */
  agentTurnRetry?: AgentTurnRetryOverride;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  /** Extra custom tools from the constructor (not a base coding-tool set). */
  private readonly extraTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly persistAgentSessions: boolean;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  private readonly projectTrusted?: boolean;
  private readonly contextLoader?: SubagentContextLoader;
  private readonly sessionId?: string;
  private readonly extensionPathFilters: ExtensionPathFilter[];
  private readonly hostRetryPolicy?: ImmutableHostRetryPolicySnapshot;
  private readonly agentTurnRetry?: AgentTurnRetryOverride;
  private readonly structuredOutputEnabled: boolean;
  private readonly settingsManagerFactory?: WorkflowAgentOptions["settingsManagerFactory"];
  /** Host extension registry facade from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Explicit execution runtime from constructor options, when provided. */
  private readonly sharedRuntime?: ModelRuntime;
  /** Cached plugin-owned runtime created on first use. */
  private cachedRuntime?: ModelRuntime;
  private cachedRuntimePromise?: Promise<ModelRuntime>;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.extraTools = options.tools ?? [];
    this.sessionOptions = options.session ?? {};
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
    this.sharedRuntime = options.modelRuntime;
    this.projectTrusted = options.projectTrusted;
    this.contextLoader = options.contextLoader;
    this.sessionId = options.sessionId;
    this.extensionPathFilters = options.extensionPathFilters ?? [];
    this.hostRetryPolicy = options.hostRetryPolicy;
    this.agentTurnRetry = options.agentTurnRetry;
    this.structuredOutputEnabled = options.structuredOutputEnabled === true;
    this.settingsManagerFactory = options.settingsManagerFactory;

    if (this.settingsManagerFactory && this.sessionOptions.settingsManager) {
      throw new Error("settingsManagerFactory conflicts with session.settingsManager");
    }
    if (this.hostRetryPolicy && this.sessionOptions.settingsManager) {
      throw new Error("host retry policy cannot be applied to a shared session.settingsManager");
    }
  }

  /** Host registry for resolution / provider copy: per-run > constructor. */
  private getHostRegistry(perRunRegistry?: ModelRegistry): ModelRegistry | undefined {
    return perRunRegistry ?? this.sharedRegistry;
  }

  /**
   * Execution ModelRuntime: constructor > cached plugin runtime.
   * Host registry is never unwrapped; dynamic providers are copied onto this runtime.
   */
  private async getModelRuntime(): Promise<ModelRuntime> {
    if (this.sharedRuntime) return this.sharedRuntime;
    if (this.cachedRuntime) return this.cachedRuntime;
    if (!this.cachedRuntimePromise) {
      const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
      this.cachedRuntimePromise = createPluginModelRuntime({ agentDir })
        .then((runtime) => {
          this.cachedRuntime = runtime;
          return runtime;
        })
        .catch((error) => {
          this.cachedRuntimePromise = undefined;
          throw error;
        });
    }
    return this.cachedRuntimePromise;
  }

  /**
   * Resolution list source after providers have been copied into the runtime.
   * Prefer the host registry (routing/catalog surface); fall back to the plugin runtime.
   */
  private getResolutionSource(runtime: ModelRuntime, hostRegistry?: ModelRegistry): ModelListSource {
    if (hostRegistry) return modelListFromRegistry(hostRegistry);
    return modelListFromRuntime(runtime);
  }

  /**
   * Session manager for one subagent run. File-backed (persisted under the
   * standard sessions dir, keyed by the runner's project cwd — never a
   * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
   *
   * SessionManager.create() only creates the session directory — the SDK writes
   * the session file lazily (synchronous fs calls, uncaught) on the first
   * assistant message, deep inside session.prompt(). A failure there would
   * otherwise throw mid-run and abort this subagent. Probe writability up front
   * so any create/write failure (permissions, disk full) degrades this single
   * agent to an in-memory session instead — the run continues, just without a
   * persisted transcript.
   */
  private createSessionManager(): SessionManager {
    if (!this.persistAgentSessions) return SessionManager.inMemory();
    try {
      const manager = SessionManager.create(this.cwd);
      this.assertSessionDirWritable(manager.getSessionDir());
      return manager;
    } catch (error) {
      console.warn(
        `[workflow] persistAgentSessions: could not persist this agent's session (${
          error instanceof Error ? error.message : String(error)
        }); continuing with an in-memory session`,
      );
      return SessionManager.inMemory();
    }
  }

  /** Best-effort write probe: throws if the session directory isn't actually writable. */
  private assertSessionDirWritable(dir: string): void {
    const probePath = join(dir, `.write-probe-${randomUUID()}`);
    writeFileSync(probePath, "");
    unlinkSync(probePath);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const runCwd = options.cwd ?? this.cwd;
    const requestedSchema = options.schema;
    const structuredOutputEnabled = options.structuredOutputEnabled ?? this.structuredOutputEnabled;
    const effectiveSchema = structuredOutputEnabled === true ? requestedSchema : undefined;
    const effectiveOptions =
      effectiveSchema === requestedSchema ? options : ({ ...options, schema: undefined } as AgentRunOptions<undefined>);

    // User/custom extras only. Built-in coding tools come from the SDK session
    // (bound to runCwd). System + schema tools are appended AFTER policy so they
    // always bypass agentType allow/deny lists (SharedStore contract).
    const userCustomTools = filterShadowingBuiltinCustomTools([...this.extraTools, ...(options.tools ?? [])]);
    const systemTools = options.systemTools ?? [];
    const systemToolNames = systemTools.map((tool) => tool.name).filter(Boolean);
    const filteredUserCustomTools = applyToolPolicy(userCustomTools, options.toolNames, options.disallowedToolNames);
    const schemaTool = effectiveSchema
      ? (createStructuredOutputTool({ schema: effectiveSchema, capture }) as unknown as ToolDefinition)
      : undefined;
    const customTools: ToolDefinition[] = [
      ...filteredUserCustomTools,
      ...systemTools,
      ...(schemaTool ? [schemaTool] : []),
    ];
    const sessionToolAllowlist = resolveSessionToolAllowlist({
      toolNames: options.toolNames,
      systemToolNames,
      includeStructuredOutput: Boolean(effectiveSchema),
    });
    // Denylist must not strip SharedStore or the enabled structured_output tool.
    const systemNameSet = new Set([...systemToolNames, ...(schemaTool ? ["structured_output"] : [])]);
    const excludeTools = (options.disallowedToolNames ?? []).filter((name) => !systemNameSet.has(name));

    // Resolve only an explicit per-agent model. Unoverridden calls inherit the
    // model selected by the owning Workflow admission.
    const modelSpec = resolveAgentModelSpec(options, this.mainModel);

    // Plugin-owned execution runtime (never unwrap host runtime from ModelRegistry).
    const hostRegistry = this.getHostRegistry(options.modelRegistry);
    const modelRuntime = await this.getModelRuntime();
    copyRegisteredProviders(hostRegistry, modelRuntime);

    // Resolve a requested model to a concrete Pi registry model. Model selection
    // failures are non-recoverable; a child must never silently use another model.
    const resolutionSource = this.getResolutionSource(modelRuntime, hostRegistry);
    let resolvedModel: Model<any> | undefined;
    let resolvedThinkingLevel: CreateAgentSessionOptions["thinkingLevel"] | undefined;
    if (modelSpec) {
      resolvedModel = resolveRegisteredModel(modelSpec, resolutionSource);
      options.onModelResolved?.(canonicalModelSpec(resolvedModel));
    }

    const effortModel = resolvedModel ?? (this.sessionOptions.model as Model<any> | undefined);
    if (options.effort !== undefined) {
      if (!effortModel) {
        throw new WorkflowError(
          "An agent effort override requires a concrete Pi session model.",
          WorkflowErrorCode.MODEL_SELECTION_ERROR,
          { recoverable: false, agentLabel: options.label },
        );
      }
      const validatedEffort = validateModelEffort(effortModel, options.effort, "Requested agent effort");
      resolvedThinkingLevel = validatedEffort as CreateAgentSessionOptions["thinkingLevel"];
      options.onEffortResolved?.(validatedEffort);
    }

    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
    // per-call runCwd: agents working in short-lived git worktrees should still
    // group under the project's session dir instead of scattering across
    // temporary worktree paths.
    const {
      resourceLoader: providedResourceLoader,
      settingsManager: providedSettingsManager,
      ...baseSessionOptions
    } = this.sessionOptions;
    const projectTrusted = this.projectTrusted;
    const settingsManager =
      providedSettingsManager ??
      this.settingsManagerFactory?.({ cwd: runCwd, agentDir, projectTrusted }) ??
      SettingsManager.create(runCwd, agentDir, projectTrusted === undefined ? undefined : { projectTrusted });
    if (projectTrusted !== undefined && providedSettingsManager) {
      try {
        providedSettingsManager.setProjectTrusted(projectTrusted);
      } catch {
        // Best-effort: older/injected managers may not expose setProjectTrusted.
      }
    }
    // Load pluggable context (Trellis, etc.) before session creation so we can
    // install a per-run bash env interceptor as an inline extension factory.
    let loadedContext: SubagentContext | undefined;
    let finalPrompt = prompt;
    let finalInstructions = options.instructions;
    if (!options.skipContextLoading) {
      const contextLoader = options.contextLoader ?? this.contextLoader;
      loadedContext = contextLoader
        ? await contextLoader({
            cwd: this.cwd,
            agentType: options.agentType,
            prompt,
            sessionId: options.sessionId ?? this.sessionId,
          })
        : undefined;
      // Task context is applied to the user prompt (and optional instructions), never
      // into the system-prompt cache. When workflow.ts pre-applies context for resume
      // hashing, it sets skipContextLoading to avoid double injection.
      const withContext = applySubagentContext(prompt, options.instructions, loadedContext);
      finalPrompt = withContext.prompt;
      finalInstructions = withContext.instructions;
    }

    const runEnv = mergeSubagentEnv(loadedContext?.env, options.env);

    const baseResourceLoader =
      providedResourceLoader ??
      new DefaultResourceLoader({
        cwd: runCwd,
        agentDir,
        settingsManager,
      });
    const resourceLoader = wrapResourceLoaderForWorkflowSubagents(baseResourceLoader, {
      extensionPathFilters: this.extensionPathFilters,
      env: runEnv,
    });
    await resourceLoader.reload(
      projectTrusted === undefined
        ? undefined
        : {
            resolveProjectTrust: async () => projectTrusted,
          },
    );
    const childSessionAllowlist = includeProviderProfileTools(
      sessionToolAllowlist,
      resourceLoader.getExtensions().extensions,
    );
    const sessionManager = this.sessionOptions.sessionManager ?? this.createSessionManager();
    const childSessionOptions: CreateAgentSessionOptions = {
      cwd: runCwd,
      agentDir,
      sessionManager,
      settingsManager,
      ...baseSessionOptions,
      modelRuntime,
      resourceLoader,
      // Per-call model/thinking wins over any sessionOptions defaults.
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...((options.effort ?? resolvedThinkingLevel ?? options.thinkingLevel) !== undefined
        ? { thinkingLevel: (options.effort ?? resolvedThinkingLevel ?? options.thinkingLevel) as never }
        : {}),
      // Re-assert after baseSessionOptions so caller overrides cannot drop the allowlist.
      customTools,
      ...(childSessionAllowlist ? { tools: childSessionAllowlist } : {}),
      ...(excludeTools.length ? { excludeTools } : {}),
    };
    const { session } = await createAgentSession(childSessionOptions);

    await session.bindExtensions({
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {
          await session.reload();
        },
      },
      onError: (error) => {
        console.error(`Extension error (${error.extensionPath}): ${error.error}`);
      },
    });

    // Session creation/binding may reload file-backed settings. Apply the
    // execution-only policy after that boundary so it remains effective for
    // the prompt while never being persisted.
    if (this.hostRetryPolicy) {
      settingsManager.applyOverrides({
        retry: childRetrySettings(this.hostRetryPolicy, this.agentTurnRetry, options.agentTurnRetry),
      });
    }

    // Name the persisted session so it's identifiable in session pickers.
    // Skip when an injected session.sessionManager override won (tests/embedders).
    if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Naming is best-effort; never fail the run over it.
      }
    }

    let removeHistoryListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.onHistory) {
        removeHistoryListener = session.subscribe(() => maybeEmitHistory());
      }

      const promptOptions = {
        ...(effectiveOptions as AgentRunOptions<any>),
        instructions: finalInstructions,
      };
      await awaitAbortableSubagentPrompt(
        () => session.prompt(this.buildPrompt(finalPrompt, promptOptions, Boolean(effectiveSchema))),
        options.signal,
        () => session.abort(),
      );

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfAssistantError(session.messages, options.label);

      if (effectiveSchema) {
        return (await resolveStructuredOutput(session, capture, effectiveSchema, effectiveOptions, (m) =>
          this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      removeHistoryListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const { tokens, cost } = session.getSessionStats();
          options.onUsage({
            input: tokens.input,
            output: tokens.output,
            cacheRead: tokens.cacheRead,
            cacheWrite: tokens.cacheWrite,
            total: tokens.total,
            cost,
          });
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
