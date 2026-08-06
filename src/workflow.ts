import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  type KeelHostBridgeV1,
  type KeelLoadedInvocationV1,
  type KeelPiInvocationV1,
  loadKeelAgentInvocation,
  observeKeelAgentStarted,
  observeKeelAgentTerminal,
  validateKeelHostBridge,
} from "./keel-host-contract.js";
import { createWorkflowLogger } from "./logger.js";
import {
  type ModelThinkingLevel,
  type ResolvedWorkflowModel,
  resolveAgentModelOverride,
  resolveWorkflowModel,
  resolveWorkflowModelSnapshot,
  type WorkflowModelSetting,
  type WorkflowModelSnapshot,
} from "./model-selection.js";
import {
  type AgentTurnRetryOverride,
  normalizeAgentTurnRetryOverride,
  normalizeExecutionPolicy,
  resolveAgentRunRetries,
} from "./retry-policy.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import { applySubagentContext, mergeSubagentContexts, type SubagentContext } from "./subagent-context.js";
import { loadWorkflowSettings, structuredOutputDisabledGuidance } from "./workflow-settings.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** Workflow frame that owns this index; absent only on legacy payloads. */
  runId?: string;
  /** sha256 of the call's identity (prompt + model + effort + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
   * deltas in callSeq order accumulates all agents' writes correctly regardless of
   * which agent finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
  nestedCallSeq: number;
  runFatalController: AbortController;
  inFlight: Set<Promise<unknown>>;
}

export interface SettledWorkflowError {
  code: WorkflowErrorCode;
  message: string;
  recoverable: boolean;
  agentLabel?: string;
}

export type SettledWorkflowResult<T> =
  | { status: "fulfilled"; value: T | null }
  | { status: "rejected"; error: SettledWorkflowError };

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  /** Sampled workflow structured-output capability for this execution. */
  structuredOutputEnabled?: boolean;
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /** The session's current Pi reasoning effort. */
  currentThinkingLevel?: string;
  /** Concrete host session model when the run is admitted. */
  sessionModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  /** Admission snapshot; nested/resumed runs must pass this instead of settings. */
  workflowModel?: WorkflowModelSnapshot;
  /** Direct-run settings override; manager-admitted runs use workflowModel instead. */
  workflowModelSetting?: WorkflowModelSetting;
  /** Optional versioned Keel host integration. Omit for the legacy workflow path. */
  keelHost?: KeelHostBridgeV1;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) +
   * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
   * fallback). Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Additional whole-agent attempts after a recoverable failure. Default 0. */
  agentRunRetries?: number;
  /** @deprecated Use agentRunRetries. */
  agentRetries?: number;
  /** Run-level partial override for Pi child agent-turn retry. */
  agentTurnRetry?: AgentTurnRetryOverride;
  tokenBudget?: number | null;
  /** Cumulative usage already spent before a resumed execution starts. */
  initialTokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
  };
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number | string, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    id: string;
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    effort?: ModelThinkingLevel;
  }) => void;
  onAgentEnd?: (event: {
    id: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
    effort?: ModelThinkingLevel;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    cancelled?: boolean;
  }) => void;
  onAgentHistory?: (event: { id: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
  /** Progressive cumulative usage, including failed retry attempts. */
  onTokenUsageProgress?: (usage: SharedRuntime["tokenUsage"]) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  /** Concrete default pair sampled before the first agent() admission. */
  defaultModel?: string;
  defaultEffort?: ModelThinkingLevel;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** Refuse a helper whose implementation requires schema-shaped agent results. */
export function assertStructuredOutputEnabled(enabled: boolean, surface: string): void {
  if (enabled) return;
  throw new WorkflowError(
    `${surface} requires workflow structured output. ${structuredOutputDisabledGuidance()}`,
    WorkflowErrorCode.STRUCTURED_OUTPUT_DISABLED,
    { recoverable: false },
  );
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Temporary per-agent model override (`provider/modelId` or a unique bare
   * model id). When omitted, the admitted Workflow Model is inherited.
   */
  model?: string;
  /** Temporary Pi-supported reasoning-effort override. */
  effort?: ModelThinkingLevel;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist and body prompt to this
   * agent. Workflow model selection remains controlled by `model`/`effort` and
   * the admitted Workflow Model; the definition's optional model is ignored.
   * An unknown name logs a warning and falls back to default tools.
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Additional whole-agent attempts after a recoverable failure for this agent. */
  agentRunRetries?: number;
  /** @deprecated Use agentRunRetries. */
  retries?: number;
  /** Per-agent partial override for Pi child agent-turn retry. */
  agentTurnRetry?: AgentTurnRetryOverride;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  const sessionModel =
    options.sessionModel ??
    (options.session?.model as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined);
  // A manager normally supplies workflowModel after admission. Direct callers
  // resolve it here once, before the script can create an agent or nested run.
  // The model-less branch exists for injected test runners that intentionally do
  // not emulate a Pi session; production ExtensionContext always supplies one.
  const admittedWorkflowModel: ResolvedWorkflowModel | undefined = options.workflowModel
    ? resolveWorkflowModelSnapshot(options.workflowModel, {
        sessionModel,
        registry: options.modelScope ?? options.modelRegistry,
        modelScope: options.modelScope,
      })
    : (() => {
        const setting =
          options.workflowModelSetting !== undefined
            ? options.workflowModelSetting
            : loadWorkflowSettings({ cwd: baseCwd }).workflowModel;
        const canResolve =
          setting !== undefined ||
          sessionModel !== undefined ||
          (options.mainModel !== undefined &&
            (options.modelScope !== undefined || options.modelRegistry !== undefined));
        return canResolve
          ? resolveWorkflowModel({
              setting,
              sessionModel,
              sessionModelId: options.mainModel,
              sessionEffort: options.currentThinkingLevel as ModelThinkingLevel | undefined,
              registry: options.modelScope ?? options.modelRegistry,
              modelScope: options.modelScope,
            })
          : undefined;
      })();
  const structuredOutputEnabled = options.structuredOutputEnabled === true;
  const executionPolicy = normalizeExecutionPolicy(options);
  if (options.keelHost) validateKeelHostBridge(options.keelHost);
  if (executionPolicy.agentTurnRetry && !options.hostRetryPolicy) {
    throw new Error("agentTurnRetry requires a host retry policy snapshot");
  }
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner =
    options.agent ?? new WorkflowAgent({ ...options, agentTurnRetry: executionPolicy.agentTurnRetry });
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: options.initialTokenUsage?.total ?? 0,
    tokenUsage: options.initialTokenUsage
      ? { ...options.initialTokenUsage }
      : { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
    nestedCallSeq: 0,
    runFatalController: new AbortController(),
    inFlight: new Set(),
  };
  const limiter = shared.limiter;
  const isTopLevelRun = options.sharedRuntime === undefined;

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();
  const signalScope = new AsyncLocalStorage<AbortSignal>();
  const currentExecutionSignal = () => signalScope.getStore() ?? options.signal;

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const throwIfAborted = () => {
    if (currentExecutionSignal()?.aborted || shared.runFatalController.signal.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agentImpl = async (prompt: string, agentOptions: AgentOptions = {}) => {
    const executionSignal = currentExecutionSignal();
    throwIfAborted();
    const perAgentTurnRetry = normalizeAgentTurnRetryOverride(agentOptions.agentTurnRetry, "agent.agentTurnRetry");
    if (perAgentTurnRetry && !options.hostRetryPolicy) {
      throw new Error("agent.agentTurnRetry requires a host retry policy snapshot");
    }
    if (Object.hasOwn(agentOptions as object, "tier")) {
      throw new WorkflowError(
        "agent(..., { tier }) is retired. Use model and/or effort for a temporary override.",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const retryAttempts = resolveAgentRunRetries(agentOptions.agentRunRetries, agentOptions.retries, {
      aliasName: "retries",
      fallback: executionPolicy.agentRunRetries ?? 0,
    });

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();

    // Resolve a named agentType to its bound definition (tools/prompt/isolation).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools`);
    }

    // Every agent inherits the admitted pair unless it supplies an independent
    // model and/or effort override. Agent-definition frontmatter never routes a
    // Workflow call.
    const modelSelection = admittedWorkflowModel
      ? resolveAgentModelOverride(
          admittedWorkflowModel,
          { model: agentOptions.model, effort: agentOptions.effort },
          options.modelScope ?? options.modelRegistry,
          options.modelScope,
        )
      : agentOptions.model !== undefined || agentOptions.effort !== undefined
        ? (() => {
            throw new WorkflowError(
              "An agent model/effort override requires an admitted Pi Workflow Model.",
              WorkflowErrorCode.MODEL_SELECTION_ERROR,
              { recoverable: false, agentLabel: agentOptions.label },
            );
          })()
        : undefined;
    let displayModel = modelSelection?.model ?? options.mainModel;
    let displayEffort = modelSelection?.effort;

    // Call-site isolation for resume hashing (requested value from options/def).
    // Worktree success/fallback is decided later and does not rewrite this hash.
    // Trellis implement/check agents always share the project cwd (native parity).
    const forceSharedCwd = isTrellisSharedCwdAgent(agentOptions.agentType);
    const requestedIsolation = forceSharedCwd ? undefined : (agentOptions.isolation ?? agentDef?.isolation);

    // Reserve lexical identity and quota before context loading yields. Parallel
    // branches must not overrun maxAgents or reorder resume journal indexes.
    const callIndex = state.callSeq++;
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);
    const requestedSchema = agentOptions.schema;
    const effectiveSchema = structuredOutputEnabled ? requestedSchema : undefined;
    const effectiveAgentOptions =
      effectiveSchema === requestedSchema ? agentOptions : { ...agentOptions, schema: undefined };
    if (effectiveSchema && (effectiveSchema as { type?: unknown }).type !== "object") {
      throw new WorkflowError(
        `agent() opts.schema must be a top-level JSON object schema (type: "object") - got type: ${(effectiveSchema as { type?: unknown }).type ?? "undefined"}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false, agentLabel: label },
      );
    }
    if (requestedSchema !== undefined && !structuredOutputEnabled) {
      log(`${label}: opts.schema ignored because workflow structured output is disabled; using text output`);
    }

    const keelSource = { workflowRunId: runId, callIndex } as const;
    let loadedKeel: KeelLoadedInvocationV1 | undefined;
    if (options.keelHost) {
      loadedKeel = await loadKeelAgentInvocation(options.keelHost, {
        source: keelSource,
        label,
        ...(assignedPhase ? { phase: assignedPhase } : {}),
        ...(agentOptions.agentType ? { agentType: agentOptions.agentType } : {}),
        cwd: baseCwd,
        prompt,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
    }

    // Apply optional context loaders (e.g. Trellis) before hashing so promptPrefix
    // participates in resume identity. The agent runner skips re-loading.
    let agentPrompt = prompt;
    let contextInstructions: string | undefined;
    let loadedEnv: Record<string, string> | undefined;
    let genericContext: SubagentContext | undefined;
    if (options.contextLoader) {
      genericContext = await options.contextLoader({
        cwd: baseCwd,
        agentType: agentOptions.agentType,
        prompt,
        sessionId: options.sessionId,
      });
    }
    const loadedContext = mergeSubagentContexts(genericContext, loadedKeel?.context);
    if (loadedContext) {
      const applied = applySubagentContext(prompt, undefined, loadedContext);
      agentPrompt = applied.prompt;
      contextInstructions = applied.instructions;
      loadedEnv = loadedContext.env;
    }

    const callHash = hashAgentCall(
      agentPrompt,
      displayModel,
      displayEffort,
      assignedPhase,
      effectiveAgentOptions,
      agentDefinitionKey(agentDef),
      requestedIsolation,
      canonicalAgentCallContext(contextInstructions, loadedEnv, loadedKeel?.invocation),
    );
    // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
    // call (see workflowFn below) shares this run's SharedStore instance but
    // restarts its own callSeq at 0, so a parent agent and a concurrently
    // running nested-run agent can both get callIndex 0 and collide in
    // SharedStore.agentDeltas — whichever commits last steals/overwrites the
    // other's journaled delta. Composing the run's own runId (unique per
    // top-level run AND per nested run, see `${runId}-nested${shared.depth}`
    // below) with callIndex makes the key unique across the whole store.
    const deltaKey = `${runId}:${callIndex}`;

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached =
      options.resumeJournal?.get(deltaKey) ?? (isTopLevelRun ? options.resumeJournal?.get(callIndex) : undefined);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, effectiveAgentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      if (options.keelHost && loadedKeel) {
        await observeKeelAgentStarted(options.keelHost, loadedKeel, keelSource, "cached_replay");
        await observeKeelAgentTerminal(options.keelHost, loadedKeel, keelSource, "cached_replay", {
          status: "succeeded",
        });
      }
      if (displayModel) log(`${label}: ${displayModel} @ ${displayEffort ?? "session effort"}`);
      options.onAgentStart?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        effort: displayEffort,
      });
      options.onAgentEnd?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: displayModel,
        effort: displayEffort,
      });
      // Apply this agent's write delta so live agents later in the run see a
      // consistent store. Additive apply preserves parallel-agent writes that
      // came from higher-callIndex agents finishing before this one.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const maxAttempts = retryAttempts + 1;

      if (options.keelHost && loadedKeel) {
        await observeKeelAgentStarted(options.keelHost, loadedKeel, keelSource, "live");
      }
      if (displayModel) log(`${label}: ${displayModel} @ ${displayEffort ?? "session effort"}`);
      options.onAgentStart?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
        effort: displayEffort,
      });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      // Precedence: explicit call-site isolation > agentDef isolation.
      // Note: passing { isolation: undefined } falls through ?? to the def's value — there
      // is no sentinel to suppress a def's isolation at the call site. Remove the agentType
      // or override with a def that has no isolation field if opt-out is needed.
      let worktree: Worktree | undefined;
      const resolvedIsolation = forceSharedCwd ? undefined : (agentOptions.isolation ?? agentDef?.isolation);
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      const activeIsolation = worktree?.isolated ? resolvedIsolation : undefined;
      const unavailableIsolation =
        resolvedIsolation === "worktree" && worktree && !worktree.isolated ? resolvedIsolation : undefined;
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;

      // Captured from the subagent's real session usage; falls back to an
      // estimate when the provider reports no usage (total === 0). Usage is reset
      // per retry attempt so a failed attempt does not double-count the next one.
      let usage: AgentUsage | undefined;
      const recordTokens = (result: unknown): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        options.onTokenUsageProgress?.({ ...shared.tokenUsage });
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          usage = undefined;
          const agentController = new AbortController();
          const onExecutionAbort = () => agentController.abort();
          const onRunFatal = () => agentController.abort();
          if (executionSignal?.aborted || shared.runFatalController.signal.aborted) {
            agentController.abort();
          } else {
            executionSignal?.addEventListener("abort", onExecutionAbort, { once: true });
            shared.runFatalController.signal.addEventListener("abort", onRunFatal, { once: true });
          }
          try {
            throwIfAborted();

            // Run agent with timeout
            const baseInstructions = buildAgentInstructions(
              assignedPhase,
              agentOptions,
              agentDef,
              activeIsolation,
              unavailableIsolation,
            );
            const mergedInstructions =
              [baseInstructions, contextInstructions].filter(Boolean).join("\n\n") || undefined;
            const runPromise = agentRunner.run(agentPrompt, {
              label,
              // Identifiable name for persisted sessions (persistAgentSessions).
              sessionName: `workflow:${runId} ${label}`,
              schema: effectiveAgentOptions.schema,
              structuredOutputEnabled,
              signal: agentController.signal,
              instructions: mergedInstructions,
              agentType: agentOptions.agentType,
              // Only skip when this run pre-applied context for the resume hash.
              // Keeps constructor-level loaders working for custom agent runners.
              // Pass env separately so nested bash still gets TRELLIS_CONTEXT_ID.
              ...(loadedContext ? { skipContextLoading: true as const, ...(loadedEnv ? { env: loadedEnv } : {}) } : {}),
              model: modelSelection?.model,
              effort: modelSelection?.effort,
              modelRegistry: options.modelRegistry,
              modelScope: options.modelScope,
              agentTurnRetry: perAgentTurnRetry,
              toolNames: agentDef?.tools,
              disallowedToolNames: agentDef?.disallowedTools,
              // Per-agent store tools track this agent's writes by the
              // run-unique deltaKey so the delta can be journaled and replayed
              // correctly on resume, even when a nested workflow() run shares
              // this store concurrently with the parent run.
              systemTools: [
                ...createAgentStoreTools(store, deltaKey),
                ...(loadedKeel?.contextTools?.map((binding) => binding.tool) ?? []),
              ],
              ...(loadedKeel ? { keelInvocation: loadedKeel.invocation } : {}),
              cwd: runCwd,
              onModelResolved: (id: string) => {
                displayModel = id;
              },
              onEffortResolved: (effort: ModelThinkingLevel) => {
                displayEffort = effort;
              },
              onUsage: (u: AgentUsage) => {
                usage = u;
              },
              onHistory: (history: AgentHistoryEntry[]) => {
                options.onAgentHistory?.({ id: deltaKey, label, phase: assignedPhase, history });
              },
            });
            shared.inFlight.add(runPromise);
            void runPromise.catch(() => {}).finally(() => shared.inFlight.delete(runPromise));
            let result: unknown;
            try {
              result = await withTimeout(runPromise, timeout, label, () => agentController.abort());
            } catch (error) {
              if (error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_TIMEOUT) {
                await runPromise.catch(() => undefined);
              }
              throw error;
            }

            throwIfAborted();
            if (isEmptyTextAgentResult(result, effectiveAgentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const tokens = recordTokens(result);
            options.onAgentJournal?.({
              index: callIndex,
              runId,
              hash: callHash,
              result,
              storeDelta: store.commitDelta(deltaKey),
            });
            if (options.keelHost && loadedKeel) {
              await observeKeelAgentTerminal(options.keelHost, loadedKeel, keelSource, "live", {
                status: "succeeded",
              });
            }
            options.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result,
              tokens,
              worktree: runCwd,
              model: displayModel,
              effort: displayEffort,
            });
            return result;
          } catch (error) {
            store.discardDelta(deltaKey);
            if (executionSignal?.aborted || shared.runFatalController.signal.aborted) {
              const runAborted = options.signal?.aborted === true;
              if (options.keelHost && loadedKeel) {
                await observeKeelAgentTerminal(options.keelHost, loadedKeel, keelSource, "live", {
                  status: "cancelled",
                  reason: runAborted ? "workflow aborted" : "parallel group cancelled",
                });
              }
              const cancellationError = runAborted
                ? wrapError(error, { agentLabel: label })
                : new WorkflowError(
                    "parallel branch cancelled after a sibling failed",
                    WorkflowErrorCode.WORKFLOW_ABORTED,
                    { recoverable: true, agentLabel: label },
                  );
              options.onAgentEnd?.({
                id: deltaKey,
                label,
                phase: assignedPhase,
                result: null,
                worktree: runCwd,
                model: displayModel,
                effort: displayEffort,
                error: cancellationError.message,
                errorCode: cancellationError.code,
                recoverable: cancellationError.recoverable,
                cancelled: true,
              });
              throw cancellationError;
            }

            const workflowError = wrapError(error, { agentLabel: label });
            if (workflowError.code === WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR) throw workflowError;
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const tokens = recordTokens(null);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            if (options.keelHost && loadedKeel) {
              await observeKeelAgentTerminal(options.keelHost, loadedKeel, keelSource, "live", {
                status: "failed",
                code: workflowError.code,
                message: workflowError.message,
                recoverable: workflowError.recoverable,
              });
            }

            options.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              worktree: runCwd,
              model: displayModel,
              effort: displayEffort,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          } finally {
            executionSignal?.removeEventListener("abort", onExecutionAbort);
            shared.runFatalController.signal.removeEventListener("abort", onRunFatal);
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort.
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  const agent = (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> => {
    const call = agentImpl(prompt, agentOptions);
    shared.inFlight.add(call);
    void call.catch(() => {}).finally(() => shared.inFlight.delete(call));
    return call;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const parentSignal = currentExecutionSignal();
    const groupController = new AbortController();
    const groupSignal = parentSignal ? AbortSignal.any([parentSignal, groupController.signal]) : groupController.signal;
    const pending = thunks.map(async (thunk, index) =>
      signalScope.run(groupSignal, async () => {
        try {
          return await thunk();
        } catch (error) {
          if (parentSignal?.aborted) throw error;
          const workflowError = wrapError(error);
          // Non-recoverable failures (token budget / agent limit exhausted) must
          // halt the whole run, exactly like a directly-awaited agent() — not be
          // swallowed into a null in the result array.
          if (!workflowError.recoverable) throw workflowError;
          log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
    try {
      return await Promise.all(pending);
    } catch (error) {
      groupController.abort();
      await Promise.allSettled(pending);
      throw error;
    }
  };

  const parallelSettled = async <T>(thunks: Array<() => Promise<T | null>>): Promise<SettledWorkflowResult<T>[]> => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallelSettled() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallelSettled() expects an array of functions, not promises. Wrap each call: () => agent(...)",
      );
    }
    const parentSignal = currentExecutionSignal();
    const outcomes = await Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          const value = await (parentSignal ? signalScope.run(parentSignal, thunk) : thunk());
          return { status: "fulfilled", value: value as T | null } as const;
        } catch (error) {
          if (parentSignal?.aborted) return { aborted: error } as const;
          const workflowError = wrapError(error);
          log(`parallelSettled[${index}] rejected: ${workflowError.message}`);
          return {
            status: "rejected",
            error: {
              code: workflowError.code,
              message: workflowError.message,
              recoverable: workflowError.recoverable,
              ...(workflowError.agentLabel ? { agentLabel: workflowError.agentLabel } : {}),
            },
          } as const;
        }
      }),
    );
    const aborted = outcomes.find((outcome): outcome is { aborted: unknown } => "aborted" in outcome);
    if (aborted) throw aborted.aborted;
    return outcomes.filter((outcome): outcome is SettledWorkflowResult<T> => !("aborted" in outcome));
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures halt the whole run (see parallel()).
            if (!workflowError.recoverable) throw workflowError;
            log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep only.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: shared,
        // Propagate the parent's store so nested agents share the same key-value space.
        sharedStore: store,
        // A child may replay only while the parent's unchanged prefix is intact.
        resumeJournal: state.firstMiss === Number.POSITIVE_INFINITY ? options.resumeJournal : undefined,
        resumeFromRunId: undefined,
        // Nested/background work inherits the parent's admission snapshot and
        // must not consult settings again.
        workflowModel: admittedWorkflowModel
          ? { model: admittedWorkflowModel.model, effort: admittedWorkflowModel.effort }
          : undefined,
        workflowModelSetting: undefined,
        runId: `${runId}-nested${++shared.nestedCallSeq}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      shared.depth--;
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    assertStructuredOutputEnabled(structuredOutputEnabled, "verify()");
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    assertStructuredOutputEnabled(structuredOutputEnabled, "judgePanel()");
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = async (taskArgs: unknown, results: unknown) => {
    assertStructuredOutputEnabled(structuredOutputEnabled, "completenessCheck()");
    return agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );
  };

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const journalKey = `${runId}:${callIndex}`;
    const cached =
      options.resumeJournal?.get(journalKey) ?? (isTopLevelRun ? options.resumeJournal?.get(callIndex) : undefined);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    let reply: unknown;
    if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    options.onAgentJournal?.({ index: callIndex, runId, hash: callHash, result: reply });
    return reply;
  };

  const context = vm.createContext({
    agent,
    parallel,
    parallelSettled,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    // Emit final token usage
    options.onTokenUsage?.(shared.tokenUsage);

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      ...(admittedWorkflowModel
        ? { defaultModel: admittedWorkflowModel.model, defaultEffort: admittedWorkflowModel.effort }
        : {}),
      tokenUsage: shared.tokenUsage,
    };
  } catch (error) {
    if (isTopLevelRun) shared.runFatalController.abort();
    throw error;
  } finally {
    if (isTopLevelRun) {
      while (shared.inFlight.size > 0) {
        await Promise.allSettled([...shared.inFlight]);
      }
      store.dispose();
    }
  }
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta & Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (Object.hasOwn(value, "model")) {
    throw new WorkflowError(
      "meta.model is retired. Workflow model selection is configured outside the script.",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
      if (Object.hasOwn(phase, "model")) {
        throw new WorkflowError(
          "meta.phases[].model is retired. Workflow model selection is configured outside the script.",
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function isTrellisSharedCwdAgent(agentType: string | undefined): boolean {
  return agentType === "trellis-implement" || agentType === "trellis-check";
}

type AgentCallContextIdentity = {
  instructions?: string;
  env?: Record<string, string>;
  keelInvocation?: KeelPiInvocationV1;
};

function canonicalAgentCallContext(
  instructions: string | undefined,
  env: Record<string, string> | undefined,
  keelInvocation: KeelPiInvocationV1 | undefined,
): AgentCallContextIdentity | undefined {
  const normalizedInstructions = instructions?.trim() || undefined;
  const normalizedEnv = env
    ? Object.fromEntries(
        Object.entries(env)
          .filter(([key, value]) => key.length > 0 && typeof value === "string")
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    : undefined;
  if (!normalizedInstructions && (!normalizedEnv || Object.keys(normalizedEnv).length === 0) && !keelInvocation) {
    return undefined;
  }
  return {
    ...(normalizedInstructions ? { instructions: normalizedInstructions } : {}),
    ...(normalizedEnv && Object.keys(normalizedEnv).length > 0 ? { env: normalizedEnv } : {}),
    ...(keelInvocation ? { keelInvocation } : {}),
  };
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  effort: ModelThinkingLevel | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
  isolation?: "worktree",
  context?: AgentCallContextIdentity,
): string {
  const identity: {
    prompt: string;
    model: string | null;
    effort: ModelThinkingLevel | null;
    phase: string | null;
    agentType: string | null;
    agentDef: string | null;
    schema: unknown;
    isolation?: "worktree";
    context?: AgentCallContextIdentity;
  } = {
    prompt,
    model: model ?? null,
    effort: effort ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
  };
  // Preserve pre-isolation serialized shape when isolation is absent so old
  // journals without the field still replay. Call-site isolation (options or
  // agentDef) intentionally changes the hash.
  if (isolation) identity.isolation = isolation;
  if (context) identity.context = context;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  activeIsolation?: "worktree",
  unavailableIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use activeIsolation so the annotation only claims isolation when the
  // subagent's cwd really points at an isolated worktree. If the request fell
  // back to the shared tree, make that explicit in the prompt too.
  if (activeIsolation) lines.push(`Requested isolation: ${activeIsolation}`);
  else if (unavailableIsolation)
    lines.push(`Isolation unavailable: requested ${unavailableIsolation}; running in the shared worktree.`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

/**
 * Run a promise with a timeout.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Cleanup is best-effort; timeout remains the primary error.
      }
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
