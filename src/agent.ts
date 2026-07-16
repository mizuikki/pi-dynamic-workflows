import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  type Extension,
  getAgentDir,
  type LoadExtensionsResult,
  ModelRegistry,
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
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import {
  loadModelTierConfig,
  type ModelTierConfig,
  resolveTierModel,
  resolveTierThinkingLevel,
} from "./model-tier-config.js";
import {
  listAvailableModelSpecsAsync as listAvailableModelSpecsAsyncCompat,
  listAvailableModelSpecs as listAvailableModelSpecsCompat,
  type ModelAvailabilitySource,
} from "./pi-compat.js";
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

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
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
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
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
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

export function resolveAgentTierThinkingLevel(
  options: { tier?: string },
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): CreateAgentSessionOptions["thinkingLevel"] | undefined {
  if (!options.tier) return undefined;
  const config = loadConfig();
  return config ? resolveTierThinkingLevel(options.tier, config) : undefined;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /**
   * Extra custom tools registered for every subagent in addition to SDK built-ins
   * and any per-run tools. Not a base coding-tool set replacement.
   */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
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
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost. `total === 0` means the provider reported no usage.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called when `model`/`tier`/phase resolved to a spec that wasn't found (fell back to session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
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
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
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
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.extraTools = options.tools ?? [];
    this.sessionOptions = options.session ?? {};
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
    this.projectTrusted = options.projectTrusted;
    this.contextLoader = options.contextLoader;
    this.sessionId = options.sessionId;
    this.extensionPathFilters = options.extensionPathFilters ?? [];
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built).
   */
  private getRegistry(perRunRegistry?: ModelRegistry): ModelRegistry {
    const providedRegistry = perRunRegistry ?? this.sharedRegistry ?? this.sessionOptions.modelRegistry;
    if (providedRegistry) {
      return providedRegistry;
    }
    if (!this.registry) {
      const dir = getAgentDir();
      // Same agentDir/auth files createAgentSession uses by default, so a model
      // resolved here carries valid credentials.
      const auth = AuthStorage.create(join(dir, "auth.json"));
      this.registry = ModelRegistry.create(auth, join(dir, "models.json"));
    }
    return this.registry;
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

    // User/custom extras only. Built-in coding tools come from the SDK session
    // (bound to runCwd). System + schema tools are appended AFTER policy so they
    // always bypass agentType allow/deny lists (SharedStore contract).
    const userCustomTools = filterShadowingBuiltinCustomTools([...this.extraTools, ...(options.tools ?? [])]);
    const systemTools = options.systemTools ?? [];
    const systemToolNames = systemTools.map((tool) => tool.name).filter(Boolean);
    const filteredUserCustomTools = applyToolPolicy(userCustomTools, options.toolNames, options.disallowedToolNames);
    const schemaTool = options.schema
      ? (createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition)
      : undefined;
    const customTools: ToolDefinition[] = [
      ...filteredUserCustomTools,
      ...systemTools,
      ...(schemaTool ? [schemaTool] : []),
    ];
    const sessionToolAllowlist = resolveSessionToolAllowlist({
      toolNames: options.toolNames,
      systemToolNames,
      includeStructuredOutput: Boolean(options.schema),
    });
    // Denylist must not strip SharedStore / structured_output (system tools).
    const systemNameSet = new Set([...systemToolNames, ...(schemaTool ? ["structured_output"] : [])]);
    const excludeTools = (options.disallowedToolNames ?? []).filter((name) => !systemNameSet.has(name));

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    const modelSpec = resolveAgentModelSpec(options, this.mainModel);

    // Resolve a requested model spec to a Model object. Specs use Pi CLI-style
    // parsing, including an optional :thinking suffix such as gpt-5.5:xhigh.
    // A given-but-unresolved spec falls back to the session default (with a
    // warning) rather than failing.
    const modelRegistry = this.getRegistry(options.modelRegistry);
    let resolvedModel: Model<any> | undefined;
    let resolvedThinkingLevel: CreateAgentSessionOptions["thinkingLevel"] | undefined;
    if (modelSpec) {
      const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry);
      if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);
      if (resolved.model) {
        resolvedModel = resolved.model;
        resolvedThinkingLevel = resolved.thinkingLevel;
        options.onModelResolved?.(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model));
      } else {
        console.warn(`[workflow] model "${modelSpec}" not found; using session default`);
        options.onModelFallback?.(modelSpec);
      }
    }

    const agentDir = this.sessionOptions.agentDir ?? getAgentDir();
    // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
    // per-call runCwd: agents working in short-lived git worktrees should still
    // group under the project's session dir instead of scattering across
    // temporary worktree paths.
    const {
      resourceLoader: providedResourceLoader,
      settingsManager: providedSettingsManager,
      modelRegistry: _sessionModelRegistry,
      ...baseSessionOptions
    } = this.sessionOptions;
    const projectTrusted = this.projectTrusted;
    const settingsManager =
      providedSettingsManager ??
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
    const sessionManager = this.sessionOptions.sessionManager ?? this.createSessionManager();
    const hostRegistry = modelRegistry;
    const childSessionOptions: CreateAgentSessionOptions = {
      cwd: runCwd,
      agentDir,
      sessionManager,
      settingsManager,
      ...baseSessionOptions,
      ...(hostRegistry ? { modelRegistry: hostRegistry } : {}),
      resourceLoader,
      // Per-call model/thinking wins over any sessionOptions defaults.
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : resolvedThinkingLevel
          ? { thinkingLevel: resolvedThinkingLevel }
          : {}),
      // Re-assert after baseSessionOptions so caller overrides cannot drop the allowlist.
      customTools,
      ...(sessionToolAllowlist ? { tools: sessionToolAllowlist } : {}),
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

    // Name the persisted session so it's identifiable in session pickers.
    // Skip when an injected session.sessionManager override won (tests/embedders).
    if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Naming is best-effort; never fail the run over it.
      }
    }

    let removeAbortListener: (() => void) | undefined;
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
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory) {
        removeHistoryListener = session.subscribe(() => maybeEmitHistory());
      }

      const promptOptions = {
        ...(options as AgentRunOptions<any>),
        instructions: finalInstructions,
      };
      await session.prompt(this.buildPrompt(finalPrompt, promptOptions, Boolean(options.schema)));

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (m) =>
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
      removeAbortListener?.();
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
