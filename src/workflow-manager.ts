/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  CreateAgentSessionOptions,
  ModelRegistry,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent, WorkflowAgentOptions } from "./agent.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { KeelHostBridgeV1 } from "./keel-host-contract.js";
import {
  type ResolvedWorkflowModel,
  resolveWorkflowModel,
  resolveWorkflowModelSnapshot,
  type WorkflowModelSnapshot,
} from "./model-selection.js";
import {
  type AgentTurnRetryOverride,
  type ImmutableHostRetryPolicySnapshot,
  normalizeExecutionPolicy,
  type WorkflowExecutionPolicy,
} from "./retry-policy.js";
import {
  createRunPersistence,
  type DeleteRunResult,
  generateRunId,
  type PersistedRunState,
  RUN_LEASE_HEARTBEAT_INTERVAL_MS,
  RUN_LEASE_STALE_AFTER_MS,
  type RunLease,
  type RunPersistence,
  type RunStatus,
  summarizePersistedRun,
  type WorkflowRunSummary,
} from "./run-persistence.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";
import { WorkflowPersistenceError } from "./workflow-database.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

export interface ManagedRun {
  runId: string;
  sessionId?: string;
  tools?: ToolDefinition[];
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  /** Concrete default model/effort admitted for this run. */
  workflowModel?: WorkflowModelSnapshot;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  executionPolicy?: WorkflowExecutionPolicy;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  executionPromise?: Promise<WorkflowRunResult>;
  heartbeatTimer?: NodeJS.Timeout;
  lastLeaseRenewalAt?: number;
  leaseLost?: boolean;
  finalizationIntent?: "release" | "delete";
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Sampled workflow structured-output capability for this execution. */
  structuredOutputEnabled?: boolean;
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Called when the workflow enters a phase. */
  onPhase?: (title: string) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Additional whole-agent attempts after recoverable failures. */
  agentRunRetries?: number;
  /** @deprecated Use agentRunRetries. */
  agentRetries?: number;
  /** Partial child agent-turn override. */
  agentTurnRetry?: AgentTurnRetryOverride;
  /** Immutable host retry snapshot sampled for this execution. */
  hostRetryPolicy?: ImmutableHostRetryPolicySnapshot;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /** Additional tools for built-in workflows and other manager-backed runs. */
  tools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), used as a session-inheritance fallback. */
  mainModel?: string;
  /**
   * Host extension ModelRegistry facade. Used for strict model resolution and as
   * the source of registered dynamic providers to copy into the plugin runtime.
   */
  modelRegistry?: ModelRegistry;
  /** Plugin-owned execution ModelRuntime for child sessions. */
  modelRuntime?: ModelRuntime;
  /** Base host session options used by subagents; per-run model overrides win. */
  session?: WorkflowAgentOptions["session"];
  /** Current host Pi reasoning effort, sampled when a run starts. */
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory. Default false (in-memory, discarded).
   */
  persistAgentSessions?: boolean;
  /** Project trust flag forwarded to subagent SettingsManager (host inheritance). */
  projectTrusted?: boolean;
  /** Optional subagent context loader (e.g. Trellis read-only task context). */
  contextLoader?: WorkflowAgentOptions["contextLoader"];
  /** Optional versioned Keel host integration, reattached by the host on resume. */
  keelHost?: KeelHostBridgeV1;
  /** Extra extension path filters for child sessions. */
  extensionPathFilters?: WorkflowAgentOptions["extensionPathFilters"];
  /** Internal test seam. Production always uses the project-bound SQLite repository. */
  persistenceFactory?: (cwd: string) => RunPersistence;
  /** Internal timing seams for deterministic lease-heartbeat tests. */
  leaseHeartbeatIntervalMs?: number;
  leaseStaleAfterMs?: number;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence?: RunPersistence;
  private persistenceFactory: (cwd: string) => RunPersistence;
  private persistedSummaries = new Map<string, WorkflowRunSummary>();
  private initialized = false;
  private disposing = false;
  private disposed = false;
  private disposalPromise?: Promise<void>;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), used as a session-inheritance fallback. */
  private mainModel?: string;
  /** Host extension ModelRegistry facade. */
  private modelRegistry?: ModelRegistry;
  /** Plugin-owned execution ModelRuntime. */
  private modelRuntime?: ModelRuntime;
  private sessionOptions?: WorkflowAgentOptions["session"];
  private currentThinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private persistAgentSessions: boolean;
  private projectTrusted?: boolean;
  private contextLoader?: WorkflowAgentOptions["contextLoader"];
  private keelHost?: KeelHostBridgeV1;
  private extensionPathFilters?: WorkflowAgentOptions["extensionPathFilters"];
  private leaseHeartbeatIntervalMs: number;
  private leaseStaleAfterMs: number;

  private admitWorkflowModel(): ResolvedWorkflowModel | undefined {
    const sessionModel = this.sessionOptions?.model as Model<Api> | undefined;
    const setting = loadWorkflowSettings({ cwd: this.cwd }).workflowModel;
    const canResolve =
      setting !== undefined ||
      sessionModel !== undefined ||
      (this.mainModel !== undefined && this.modelRegistry !== undefined);
    if (!canResolve) return undefined;
    return resolveWorkflowModel({
      setting,
      sessionModel,
      sessionModelId: this.mainModel,
      sessionEffort: this.currentThinkingLevel as ModelThinkingLevel | undefined,
      registry: this.modelRegistry,
    });
  }

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.modelRuntime = options.modelRuntime;
    this.sessionOptions = options.session;
    this.currentThinkingLevel = options.thinkingLevel;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.projectTrusted = options.projectTrusted;
    this.contextLoader = options.contextLoader;
    this.keelHost = options.keelHost;
    this.extensionPathFilters = options.extensionPathFilters;
    this.persistenceFactory = options.persistenceFactory ?? createRunPersistence;
    this.leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? RUN_LEASE_HEARTBEAT_INTERVAL_MS;
    this.leaseStaleAfterMs = options.leaseStaleAfterMs ?? RUN_LEASE_STALE_AFTER_MS;
  }

  initialize(): void {
    if (this.disposing || this.disposed) throw new Error("Workflow manager is disposed.");
    if (this.initialized) return;
    const persistence = this.persistenceFactory(this.cwd);
    this.persistence = persistence;
    try {
      this.recoverStaleRuns();
      this.refreshRunSummaries();
      this.initialized = true;
    } catch (error) {
      persistence.close();
      this.persistence = undefined;
      throw error;
    }
  }

  private repository(): RunPersistence {
    if (this.disposing || this.disposed) throw new Error("Workflow manager is disposed.");
    if (!this.initialized) this.initialize();
    if (!this.persistence) throw new Error("Workflow persistence is unavailable.");
    return this.persistence;
  }

  async dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    if (this.disposed) return;
    this.disposing = true;
    this.disposalPromise = (async () => {
      const pending: Promise<unknown>[] = [];
      for (const run of this.runs.values()) {
        if (run.status === "running") {
          run.status = "paused";
          run.controller.abort();
          this.persistRun(run);
        }
        if (run.executionPromise) pending.push(run.executionPromise.catch(() => undefined));
        else this.releaseRunLease(run);
      }
      await Promise.allSettled(pending);
      for (const run of this.runs.values()) {
        this.stopLeaseHeartbeat(run);
        this.releaseRunLease(run);
      }
      this.persistence?.close();
      this.persistence = undefined;
      this.disposed = true;
      this.disposing = false;
    })();
    return this.disposalPromise;
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    const persistence = this.persistence;
    if (!persistence) return;
    for (const summary of persistence.listSummaries()) {
      if (summary.status !== "running" || this.runs.has(summary.runId)) continue;
      const lease = persistence.acquireRunLease(summary.runId, "existing");
      if (!lease) continue;
      try {
        const state = persistence.load(summary.runId);
        if (!state || state.runId !== summary.runId || state.sessionId !== summary.sessionId) continue;
        state.status = "paused";
        persistence.save(state, lease);
      } finally {
        persistence.releaseRunLease(lease);
      }
    }
  }

  /** Set the session's main model (provider/id) for session inheritance. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host extension ModelRegistry facade (resolution + provider copy source). */
  setModelRegistry(registry: ModelRegistry | undefined): void {
    this.modelRegistry = registry;
  }

  /** Set the plugin-owned execution ModelRuntime for child sessions. */
  setModelRuntime(runtime: ModelRuntime | undefined): void {
    this.modelRuntime = runtime;
  }

  setSessionOptions(session: WorkflowAgentOptions["session"] | undefined): void {
    this.sessionOptions = session;
  }

  setThinkingLevel(level: CreateAgentSessionOptions["thinkingLevel"] | undefined): void {
    this.currentThinkingLevel = level;
  }

  setProjectTrusted(trusted: boolean | undefined): void {
    this.projectTrusted = trusted;
  }

  setContextLoader(loader: WorkflowAgentOptions["contextLoader"] | undefined): void {
    this.contextLoader = loader;
  }

  setKeelHost(bridge: KeelHostBridgeV1 | undefined): void {
    this.keelHost = bridge;
  }

  setExtensionPathFilters(filters: WorkflowAgentOptions["extensionPathFilters"] | undefined): void {
    this.extensionPathFilters = filters;
  }

  /**
   * The host session's model registry facade, when set. Read lazily (e.g. by the
   * workflow tool's Workflow Model guideline) since `setModelRegistry` is called
   * from `session_start`, which runs after the tool is created — a snapshot
   * taken at tool-creation time would miss it.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  getModelRuntime(): ModelRuntime | undefined {
    return this.modelRuntime;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const persistence = this.repository();
    const executionPolicy = normalizeExecutionPolicy(exec);
    const parsed = parseWorkflowScript(script);
    const admittedWorkflowModel = this.admitWorkflowModel();
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    const controller = new AbortController();
    const lease = persistence.acquireRunLease(runId, "new");
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      sessionId: this.sessionId,
      tools: exec.tools,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        ...(admittedWorkflowModel
          ? { defaultModel: admittedWorkflowModel.model, defaultEffort: admittedWorkflowModel.effort }
          : {}),
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      ...(admittedWorkflowModel
        ? { workflowModel: { model: admittedWorkflowModel.model, effort: admittedWorkflowModel.effort } }
        : {}),
      args,
      journal: [],
      ...(Object.keys(executionPolicy).length ? { executionPolicy } : {}),
      background: true,
      lease,
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      const initialState: PersistedRunState = {
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        sessionId: managed.sessionId,
        status: "running",
        ...(admittedWorkflowModel
          ? { defaultModel: admittedWorkflowModel.model, defaultEffort: admittedWorkflowModel.effort }
          : {}),
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
        ...(managed.executionPolicy ? { executionPolicy: managed.executionPolicy } : {}),
      };
      persistence.save(initialState, lease);
      this.persistedSummaries.set(runId, summarizePersistedRun(lease.projectId, initialState));
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.beginExecution(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const persistence = this.repository();
    const managed = this.createManaged(script, args);
    const executionPolicy = normalizeExecutionPolicy(exec);
    if (Object.keys(executionPolicy).length) managed.executionPolicy = executionPolicy;
    const lease = persistence.acquireRunLease(managed.runId, "new");
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    try {
      this.persistRun(managed, true);
    } catch (error) {
      this.releaseRunLease(managed);
      this.runs.delete(managed.runId);
      throw error;
    }
    return this.beginExecution(managed, script, args, exec);
  }

  private beginExecution(
    managed: ManagedRun,
    script: string,
    args: unknown,
    exec: ExecOptions,
  ): Promise<WorkflowRunResult> {
    managed.finalizationIntent = "release";
    this.startLeaseHeartbeat(managed);
    const promise = this.executeRun(managed, script, args, exec);
    managed.executionPromise = promise;
    void promise.finally(() => this.stopLeaseHeartbeat(managed)).catch(() => {});
    return promise;
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const admittedWorkflowModel = this.admitWorkflowModel();
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    return {
      runId,
      sessionId: this.sessionId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        ...(admittedWorkflowModel
          ? { defaultModel: admittedWorkflowModel.model, defaultEffort: admittedWorkflowModel.effort }
          : {}),
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      ...(admittedWorkflowModel
        ? { workflowModel: { model: admittedWorkflowModel.model, effort: admittedWorkflowModel.effort } }
        : {}),
      args,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      hostRetryPolicy,
      structuredOutputEnabled,
      confirm,
      tools,
      onPhase,
    } = exec;
    const runTools = tools ?? managed.tools;
    const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const progress = () => onProgress?.(managed.snapshot);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        persistLogs: false,
        args,
        agent: this.agent,
        tools: runTools,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        modelRuntime: this.modelRuntime,
        session:
          this.sessionOptions || this.currentThinkingLevel
            ? {
                ...this.sessionOptions,
                ...(this.currentThinkingLevel ? { thinkingLevel: this.currentThinkingLevel } : {}),
              }
            : undefined,
        currentThinkingLevel: this.currentThinkingLevel,
        sessionModel: this.sessionOptions?.model as Model<Api> | undefined,
        workflowModel: managed.workflowModel,
        persistAgentSessions: this.persistAgentSessions,
        projectTrusted: this.projectTrusted,
        contextLoader: this.contextLoader,
        keelHost: this.keelHost,
        extensionPathFilters: this.extensionPathFilters,
        hostRetryPolicy,
        structuredOutputEnabled,
        agentTurnRetry: managed.executionPolicy?.agentTurnRetry,
        sessionId: managed.sessionId,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRunRetries: managed.executionPolicy?.agentRunRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          // Append (crash-safe-ish): keep the latest entry per index, then persist.
          managed.journal = managed.journal.filter((e) => e.index !== entry.index);
          managed.journal.push(entry);
          this.persistRun(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
          onPhase?.(title);
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
            effort: event.effort,
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.model) agent.model = event.model;
            if (event.effort) agent.effort = event.effort;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.status = "completed";
      managed.result = result;
      this.persistRun(managed);
      if (!managed.leaseLost) this.emit("complete", { runId: managed.runId, result });
      this.finalizeRunLease(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      if (managed.leaseLost) {
        this.finalizeRunLease(managed);
        throw workflowError;
      }

      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      this.persistRun(managed);
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else {
        if (this.listenerCount("error") > 0) this.emit("error", { runId: managed.runId, error: workflowError });
      }

      this.finalizeRunLease(managed);

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    try {
      this.persistence?.releaseRunLease(managed.lease);
    } catch {
      // A token-guarded release can be retried by stale recovery.
    }
    managed.lease = undefined;
  }

  private finalizeRunLease(managed: ManagedRun): void {
    if (managed.finalizationIntent !== "delete") this.releaseRunLease(managed);
  }

  private startLeaseHeartbeat(managed: ManagedRun): void {
    if (!managed.lease) return;
    managed.lastLeaseRenewalAt = Date.now();
    const timer = setInterval(() => {
      if (!managed.lease || managed.leaseLost) return;
      try {
        if (this.persistence?.renewRunLease(managed.lease)) {
          managed.lastLeaseRenewalAt = Date.now();
          return;
        }
        this.markLeaseLost(managed);
      } catch {
        if (Date.now() - (managed.lastLeaseRenewalAt ?? 0) >= this.leaseStaleAfterMs) this.markLeaseLost(managed);
      }
    }, this.leaseHeartbeatIntervalMs);
    timer.unref?.();
    managed.heartbeatTimer = timer;
  }

  private stopLeaseHeartbeat(managed: ManagedRun): void {
    if (managed.heartbeatTimer) clearInterval(managed.heartbeatTimer);
    managed.heartbeatTimer = undefined;
  }

  private markLeaseLost(managed: ManagedRun): void {
    if (managed.leaseLost) return;
    managed.leaseLost = true;
    managed.controller.abort();
    console.warn(`[workflow-manager] Workflow run ownership lost (${managed.runId}).`);
  }

  private persistedState(managed: ManagedRun): PersistedRunState {
    return {
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      script: managed.script,
      args: managed.args,
      ...(managed.workflowModel
        ? { defaultModel: managed.workflowModel.model, defaultEffort: managed.workflowModel.effort }
        : {}),
      sessionId: managed.sessionId,
      journal: managed.journal,
      ...(managed.executionPolicy ? { executionPolicy: managed.executionPolicy } : {}),
      status: managed.status,
      pauseReason:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
          ? "usage_limit"
          : undefined,
      resetHint:
        managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
          ? managed.error.resetHint
          : undefined,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => ({
        ...a,
        startedAt: managed.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: managed.snapshot.tokenUsage
        ? {
            input: managed.snapshot.tokenUsage.input,
            output: managed.snapshot.tokenUsage.output,
            total: managed.snapshot.tokenUsage.total,
            cost: managed.snapshot.tokenUsage.cost,
            cacheRead: managed.snapshot.tokenUsage.cacheRead,
            cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
          }
        : undefined,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
    };
  }

  private persistRun(managed: ManagedRun, required = false): boolean {
    if (!managed.lease || managed.leaseLost) return false;
    const state = this.persistedState(managed);
    try {
      const persistence = this.persistence;
      if (!persistence) throw new Error("Workflow persistence is unavailable.");
      persistence.save(state, managed.lease);
      this.persistedSummaries.set(managed.runId, summarizePersistedRun(managed.lease.projectId, state));
      managed.lastLeaseRenewalAt = Date.now();
      return true;
    } catch (err) {
      if (err instanceof WorkflowPersistenceError && err.code === "LEASE_LOST") this.markLeaseLost(managed);
      if (required) throw err;
      console.warn("[workflow-manager] Workflow checkpoint failed.");
      return false;
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.getRun(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.persistRun(managed);
    this.emit("paused", { runId });
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(
    runId: string,
    exec: Pick<ExecOptions, "hostRetryPolicy" | "structuredOutputEnabled"> = {},
  ): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.getRun(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;
    if (active?.executionPromise) await active.executionPromise.catch(() => undefined);

    const persistence = this.repository();
    const summary = persistence.getSummary(runId);
    if (!summary || !this.canAccessSummary(summary) || summary.status === "completed" || summary.status === "aborted") {
      return false;
    }
    const lease = persistence.acquireRunLease(runId, "existing");
    if (!lease) return false;
    let persisted: PersistedRunState | null;
    try {
      persisted = persistence.load(runId);
    } catch (error) {
      persistence.releaseRunLease(lease);
      throw error;
    }
    if (
      !persisted?.script ||
      persisted.runId !== summary.runId ||
      persisted.sessionId !== summary.sessionId ||
      persisted.status === "completed" ||
      persisted.status === "aborted"
    ) {
      persistence.releaseRunLease(lease);
      return false;
    }

    let resumedWorkflowModel: WorkflowModelSnapshot | undefined;
    try {
      const persistedModel =
        typeof persisted.defaultModel === "string" && persisted.defaultModel.trim()
          ? persisted.defaultModel.trim()
          : undefined;
      const persistedEffort =
        typeof persisted.defaultEffort === "string" && persisted.defaultEffort.trim()
          ? persisted.defaultEffort
          : undefined;
      if (persistedModel === undefined && persistedEffort === undefined) {
        // Runs written before the additive snapshot fields have no original pair
        // to restore. Keep those payloads structurally resumable when the host can
        // still admit a model; every new run persists both fields and therefore
        // always follows the strict snapshot path below.
        const admitted = this.admitWorkflowModel();
        resumedWorkflowModel = admitted ? { model: admitted.model, effort: admitted.effort } : undefined;
      } else {
        if (persistedModel === undefined || persistedEffort === undefined) {
          throw new WorkflowError(
            "This run has an incomplete persisted Workflow Model snapshot and cannot be resumed safely. " +
              "Start a new run with a registered Pi model.",
            WorkflowErrorCode.MODEL_SELECTION_ERROR,
            { recoverable: false },
          );
        }
        resumedWorkflowModel = resolveWorkflowModelSnapshot(
          { model: persistedModel, effort: persistedEffort },
          {
            sessionModel: this.sessionOptions?.model as Model<Api> | undefined,
            registry: this.modelRegistry,
          },
        );
      }
    } catch (error) {
      persistence.releaseRunLease(lease);
      throw error;
    }

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      sessionId: persisted.sessionId,
      tools: active?.tools,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        ...(resumedWorkflowModel
          ? { defaultModel: resumedWorkflowModel.model, defaultEffort: resumedWorkflowModel.effort }
          : {}),
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      workflowModel: resumedWorkflowModel,
      args: persisted.args,
      journal: persisted.journal ?? [],
      executionPolicy: persisted.executionPolicy,
      background: true,
      lease,
    };
    this.runs.set(runId, managed);
    try {
      // Persist before notifying renderers: listRuns() is their source of truth for
      // lifecycle status, while getRun() supplies the live in-memory snapshot.
      this.persistRun(managed, true);
    } catch (error) {
      this.runs.delete(runId);
      this.releaseRunLease(managed);
      throw error;
    }

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.beginExecution(managed, persisted.script, persisted.args, { ...exec, resumeJournal }).catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.getRun(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.persistRun(managed);
    this.emit("stopped", { runId });
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    const run = this.runs.get(runId);
    return run && (!this.sessionId || run.sessionId === this.sessionId) ? run : undefined;
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): WorkflowRunSummary[] {
    this.repository();
    const summaries = [...this.persistedSummaries.values()];
    return summaries
      .filter((summary) => this.canAccessSummary(summary))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  refreshRunSummaries(): void {
    const persistence = this.persistence ?? this.repository();
    this.persistedSummaries = new Map(persistence.listSummaries().map((summary) => [summary.runId, summary]));
  }

  private canAccessSummary(summary: WorkflowRunSummary): boolean {
    return this.sessionId === undefined || summary.sessionId === this.sessionId;
  }

  loadRun(runId: string): PersistedRunState | null {
    const persistence = this.repository();
    const summary = persistence.getSummary(runId);
    if (!summary || !this.canAccessSummary(summary)) return null;
    const state = persistence.load(runId);
    if (!state || state.runId !== summary.runId || state.sessionId !== summary.sessionId) {
      throw new WorkflowPersistenceError("CORRUPT_RUN", "A workflow run payload identity is invalid.");
    }
    this.persistedSummaries.set(runId, summary);
    return state;
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.getRun(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  async deleteRun(runId: string): Promise<DeleteRunResult> {
    const persistence = this.repository();
    const summary = persistence.getSummary(runId);
    if (!summary || !this.canAccessSummary(summary)) return "not_found";
    const managed = this.getRun(runId);
    let lease: RunLease | null | undefined = managed?.lease;
    let acquiredLease = false;
    if (managed?.lease) {
      managed.finalizationIntent = "delete";
      managed.controller.abort();
      if (managed.executionPromise) await managed.executionPromise.catch(() => undefined);
      lease = managed.lease;
    } else {
      lease = persistence.acquireRunLease(runId, "existing");
      if (!lease) return persistence.getSummary(runId) ? "leased" : "not_found";
      acquiredLease = true;
    }
    if (!lease) return "leased";
    try {
      const result = persistence.delete(runId, lease);
      if (result === "deleted") {
        this.runs.delete(runId);
        this.persistedSummaries.delete(runId);
        if (managed) managed.lease = undefined;
      }
      return result;
    } catch (error) {
      if (acquiredLease) persistence.releaseRunLease(lease);
      throw error;
    }
  }
}
