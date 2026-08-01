import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { ModelThinkingLevel } from "./model-selection.js";
import { normalizeExecutionPolicy, type WorkflowExecutionPolicy } from "./retry-policy.js";
import {
  type OpenWorkflowDatabaseOptions,
  openWorkflowDatabase,
  WORKFLOW_PAYLOAD_VERSION,
  WorkflowPersistenceError,
} from "./workflow-database.js";
import { workflowCanonicalProjectPath, workflowProjectKey } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export const RUN_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUN_LEASE_STALE_AFTER_MS = 60_000;

const RUN_STATUSES = new Set<RunStatus>(["pending", "running", "paused", "completed", "failed", "aborted"]);
const AGENT_STATUSES = new Set(["queued", "running", "done", "error", "skipped"]);

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  model?: string;
  effort?: ModelThinkingLevel;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** Concrete default pair sampled at workflow admission. */
  defaultModel?: string;
  defaultEffort?: ModelThinkingLevel;
  toolNames?: string[];
  sessionId?: string;
  status: RunStatus;
  pauseReason?: string;
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  journal?: Array<{ index: number; hash: string; result: unknown; storeDelta?: Record<string, unknown> }>;
  /** Explicit canonical run policy only; host snapshots are never persisted. */
  executionPolicy?: WorkflowExecutionPolicy;
}

export interface WorkflowRunSummary {
  projectId: string;
  runId: string;
  sessionId?: string;
  workflowName: string;
  status: RunStatus;
  currentPhase?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  agentCounts: { total: number; running: number; done: number; error: number };
  tokenUsage?: PersistedRunState["tokenUsage"];
  hasScript: boolean;
}

export interface RunLease {
  projectId: string;
  runId: string;
  token: string;
}

export type DeleteRunResult = "deleted" | "not_found" | "leased";
export type RunLeaseAcquireMode = "new" | "existing";

export interface RunPersistence {
  save(state: PersistedRunState, lease: RunLease): void;
  getSummary(runId: string): WorkflowRunSummary | null;
  load(runId: string): PersistedRunState | null;
  listSummaries(sessionId?: string): WorkflowRunSummary[];
  delete(runId: string, lease: RunLease): DeleteRunResult;
  acquireRunLease(runId: string, mode: RunLeaseAcquireMode): RunLease | null;
  renewRunLease(lease: RunLease): boolean;
  releaseRunLease(lease: RunLease): void;
  close(): void;
}

export function summarizePersistedRun(projectId: string, state: PersistedRunState): WorkflowRunSummary {
  const total = state.agents.length;
  const running = state.agents.filter((agent) => agent.status === "running").length;
  const done = state.agents.filter((agent) => agent.status === "done").length;
  const error = state.agents.filter((agent) => agent.status === "error").length;
  return {
    projectId,
    runId: state.runId,
    sessionId: state.sessionId,
    workflowName: state.workflowName,
    status: state.status,
    currentPhase: state.currentPhase,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    durationMs: state.durationMs,
    agentCounts: { total, running, done, error },
    tokenUsage: state.tokenUsage,
    hasScript: state.script.trim().length > 0,
  };
}

interface PersistenceOptions extends OpenWorkflowDatabaseOptions {
  now?: () => number;
  pid?: number;
  pidIsAlive?: (pid: number) => boolean;
}

interface SummaryRow {
  project_id: string;
  run_id: string;
  session_id: string | null;
  workflow_name: string;
  status: string;
  current_phase: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  agent_total: number;
  agent_running: number;
  agent_done: number;
  agent_error: number;
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
  token_cost: number | null;
  token_cache_read: number | null;
  token_cache_write: number | null;
  has_script: number;
  payload_version: number;
}

function fail(code: string, message: string): never {
  throw new WorkflowPersistenceError(code, message);
}

function validString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail("INVALID_RUN_STATE", `Invalid ${field}.`);
}

function validOptionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") fail("INVALID_RUN_STATE", `Invalid ${field}.`);
}

function validNumber(value: unknown, field: string, optional = false): asserts value is number | undefined {
  if (optional && value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    fail("INVALID_RUN_STATE", `Invalid ${field}.`);
  }
}

function validInteger(value: unknown, field: string, optional = false): asserts value is number | undefined {
  validNumber(value, field, optional);
  if (value !== undefined && !Number.isSafeInteger(value)) fail("INVALID_RUN_STATE", `Invalid ${field}.`);
}

function assertJsonSafe(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      fail("INVALID_RUN_STATE", "Run state contains an invalid number.");
    return;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    fail("INVALID_RUN_STATE", "Run state is not JSON serializable.");
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) fail("INVALID_RUN_STATE", "Run state contains a cycle.");
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>))
    assertJsonSafe(item, seen);
  seen.delete(value);
}

function validateState(state: PersistedRunState): void {
  if (!state || typeof state !== "object") fail("INVALID_RUN_STATE", "Run state is invalid.");
  validString(state.runId, "run id");
  validString(state.workflowName, "workflow name", true);
  validString(state.script, "script", true);
  validOptionalString(state.sessionId, "session id");
  validOptionalString(state.defaultModel, "default model");
  validOptionalString(state.defaultEffort, "default effort");
  validOptionalString(state.pauseReason, "pause reason");
  validOptionalString(state.resetHint, "reset hint");
  if (!RUN_STATUSES.has(state.status)) fail("INVALID_RUN_STATE", "Invalid run status.");
  validOptionalString(state.currentPhase, "current phase");
  validString(state.startedAt, "start time");
  validString(state.updatedAt, "update time");
  validOptionalString(state.completedAt, "completion time");
  validInteger(state.durationMs, "duration", true);
  if (!Array.isArray(state.agents) || !Array.isArray(state.phases) || !Array.isArray(state.logs)) {
    fail("INVALID_RUN_STATE", "Run state collections are invalid.");
  }
  if (
    state.toolNames !== undefined &&
    (!Array.isArray(state.toolNames) || state.toolNames.some((name) => typeof name !== "string"))
  ) {
    fail("INVALID_RUN_STATE", "Run tool names are invalid.");
  }
  if (
    state.phases.some((phase) => typeof phase !== "string") ||
    state.logs.some((entry) => typeof entry !== "string")
  ) {
    fail("INVALID_RUN_STATE", "Run state collections are invalid.");
  }
  for (const agent of state.agents) {
    if (!agent || typeof agent !== "object") fail("INVALID_RUN_STATE", "Run agent state is invalid.");
    validInteger(agent.id, "agent id");
    validString(agent.label, "agent label", true);
    validOptionalString(agent.phase, "agent phase");
    validString(agent.prompt, "agent prompt", true);
    if (!AGENT_STATUSES.has(agent.status)) fail("INVALID_RUN_STATE", "Invalid agent status.");
    validOptionalString(agent.error, "agent error");
    validOptionalString(agent.errorCode, "agent error code");
    validOptionalString(agent.startedAt, "agent start time");
    validOptionalString(agent.endedAt, "agent end time");
    validOptionalString(agent.model, "agent model");
    validOptionalString(agent.effort, "agent effort");
    if (agent.recoverable !== undefined && typeof agent.recoverable !== "boolean") {
      fail("INVALID_RUN_STATE", "Invalid agent recoverability.");
    }
    if (agent.history !== undefined && !Array.isArray(agent.history)) {
      fail("INVALID_RUN_STATE", "Invalid agent history.");
    }
  }
  if (state.tokenUsage) {
    validInteger(state.tokenUsage.input, "input tokens");
    validInteger(state.tokenUsage.output, "output tokens");
    validInteger(state.tokenUsage.total, "total tokens");
    validNumber(state.tokenUsage.cost, "token cost", true);
    validInteger(state.tokenUsage.cacheRead, "cache read tokens", true);
    validInteger(state.tokenUsage.cacheWrite, "cache write tokens", true);
  }
  if (state.journal !== undefined) {
    if (!Array.isArray(state.journal)) fail("INVALID_RUN_STATE", "Run journal is invalid.");
    for (const entry of state.journal) {
      if (!entry || typeof entry !== "object") fail("INVALID_RUN_STATE", "Run journal is invalid.");
      validInteger(entry.index, "journal index");
      validString(entry.hash, "journal hash");
    }
  }
  if (state.executionPolicy !== undefined) {
    const normalized = normalizeExecutionPolicy(state.executionPolicy);
    if (!isDeepStrictEqual(normalized, state.executionPolicy)) {
      fail("INVALID_RUN_STATE", "Run execution policy is invalid.");
    }
  }
  assertJsonSafe(state);
}

function decodeSummary(row: SummaryRow): WorkflowRunSummary {
  if (
    typeof row.project_id !== "string" ||
    !row.project_id ||
    typeof row.run_id !== "string" ||
    !row.run_id ||
    (row.session_id !== null && typeof row.session_id !== "string") ||
    typeof row.workflow_name !== "string" ||
    !RUN_STATUSES.has(row.status as RunStatus) ||
    (row.current_phase !== null && typeof row.current_phase !== "string") ||
    typeof row.started_at !== "string" ||
    !row.started_at ||
    typeof row.updated_at !== "string" ||
    !row.updated_at ||
    (row.completed_at !== null && typeof row.completed_at !== "string") ||
    row.payload_version !== WORKFLOW_PAYLOAD_VERSION ||
    (row.has_script !== 0 && row.has_script !== 1)
  ) {
    fail("CORRUPT_RUN", "A workflow run summary is invalid.");
  }
  for (const value of [
    row.duration_ms,
    row.agent_total,
    row.agent_running,
    row.agent_done,
    row.agent_error,
    row.token_input,
    row.token_output,
    row.token_total,
    row.token_cache_read,
    row.token_cache_write,
  ]) {
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) fail("CORRUPT_RUN", "A workflow run summary count is invalid.");
  }
  if (
    row.agent_running > row.agent_total ||
    row.agent_done > row.agent_total ||
    row.agent_error > row.agent_total ||
    (row.token_cost !== null && (!Number.isFinite(row.token_cost) || row.token_cost < 0)) ||
    (row.token_total === null &&
      [row.token_input, row.token_output, row.token_cost, row.token_cache_read, row.token_cache_write].some(
        (value) => value !== null,
      )) ||
    (row.token_total !== null && (row.token_input === null || row.token_output === null))
  ) {
    fail("CORRUPT_RUN", "A workflow run summary is invalid.");
  }
  const tokenUsage =
    row.token_total === null
      ? undefined
      : {
          input: row.token_input ?? 0,
          output: row.token_output ?? 0,
          total: row.token_total,
          ...(row.token_cost === null ? {} : { cost: row.token_cost }),
          ...(row.token_cache_read === null ? {} : { cacheRead: row.token_cache_read }),
          ...(row.token_cache_write === null ? {} : { cacheWrite: row.token_cache_write }),
        };
  return {
    projectId: row.project_id,
    runId: row.run_id,
    sessionId: row.session_id ?? undefined,
    workflowName: row.workflow_name,
    status: row.status as RunStatus,
    currentPhase: row.current_phase ?? undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    agentCounts: {
      total: row.agent_total,
      running: row.agent_running,
      done: row.agent_done,
      error: row.agent_error,
    },
    tokenUsage,
    hasScript: row.has_script === 1,
  };
}

const SUMMARY_COLUMNS = `project_id, run_id, session_id, workflow_name, status, current_phase,
  started_at, updated_at, completed_at, duration_ms, agent_total, agent_running, agent_done, agent_error,
  token_input, token_output, token_total, token_cost, token_cache_read, token_cache_write, has_script, payload_version`;

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction may already have rolled back.
  }
}

export function createRunPersistence(cwd: string, options: PersistenceOptions = {}): RunPersistence {
  const db = openWorkflowDatabase(options);
  const projectId = workflowProjectKey(cwd);
  const canonicalPath = workflowCanonicalProjectPath(cwd);
  const now = options.now ?? Date.now;
  const ownerPid = options.pid ?? process.pid;
  const isPidAlive = options.pidIsAlive ?? pidIsAlive;
  let closed = false;

  const requireOpen = () => {
    if (closed) fail("PERSISTENCE_CLOSED", "Workflow persistence is closed.");
  };
  const prepare = (sql: string): StatementSync => {
    requireOpen();
    return db.prepare(sql);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const byId = db.prepare("SELECT canonical_path FROM projects WHERE project_id = ?").get(projectId) as
      | { canonical_path: string }
      | undefined;
    if (byId && byId.canonical_path !== canonicalPath)
      fail("PROJECT_COLLISION", "The workflow project identity is already bound.");
    const byPath = db.prepare("SELECT project_id FROM projects WHERE canonical_path = ?").get(canonicalPath) as
      | { project_id: string }
      | undefined;
    if (byPath && byPath.project_id !== projectId)
      fail("PROJECT_COLLISION", "The workflow project path is already bound.");
    const timestamp = new Date(now()).toISOString();
    db.prepare(
      `INSERT INTO projects(project_id, canonical_path, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(projectId, canonicalPath, timestamp, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    try {
      db.close();
    } catch {
      // Preserve the project registration failure.
    }
    throw error;
  }

  const getSummaryStatement = prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM workflow_runs WHERE project_id = ? AND run_id = ?`,
  );
  const listAllStatement = prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM workflow_runs WHERE project_id = ? ORDER BY updated_at DESC`,
  );
  const listSessionStatement = prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM workflow_runs WHERE project_id = ? AND session_id = ? ORDER BY updated_at DESC`,
  );
  const loadStatement = prepare(
    `SELECT r.session_id, r.payload_version, p.state_json
     FROM workflow_runs r JOIN workflow_run_payloads p USING(project_id, run_id)
     WHERE r.project_id = ? AND r.run_id = ?`,
  );
  const leaseStatement = prepare(
    "SELECT owner_pid, owner_token, heartbeat_at_ms FROM workflow_run_leases WHERE project_id = ? AND run_id = ?",
  );
  const existingRunStatement = prepare("SELECT session_id FROM workflow_runs WHERE project_id = ? AND run_id = ?");
  const saveRunStatement = prepare(
    `INSERT INTO workflow_runs(
      project_id, run_id, session_id, workflow_name, status, current_phase, started_at, updated_at,
      completed_at, duration_ms, agent_total, agent_running, agent_done, agent_error, token_input,
      token_output, token_total, token_cost, token_cache_read, token_cache_write, has_script, payload_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, run_id) DO UPDATE SET
      workflow_name=excluded.workflow_name, status=excluded.status, current_phase=excluded.current_phase,
      updated_at=excluded.updated_at, completed_at=excluded.completed_at, duration_ms=excluded.duration_ms,
      agent_total=excluded.agent_total, agent_running=excluded.agent_running, agent_done=excluded.agent_done,
      agent_error=excluded.agent_error, token_input=excluded.token_input, token_output=excluded.token_output,
      token_total=excluded.token_total, token_cost=excluded.token_cost, token_cache_read=excluded.token_cache_read,
      token_cache_write=excluded.token_cache_write, has_script=excluded.has_script, payload_version=excluded.payload_version`,
  );
  const savePayloadStatement = prepare(
    `INSERT INTO workflow_run_payloads(project_id, run_id, state_json) VALUES (?, ?, ?)
     ON CONFLICT(project_id, run_id) DO UPDATE SET state_json = excluded.state_json`,
  );
  const updateLeaseHeartbeatStatement = prepare(
    "UPDATE workflow_run_leases SET heartbeat_at_ms = ? WHERE project_id = ? AND run_id = ? AND owner_token = ?",
  );
  const runExistsStatement = prepare("SELECT 1 AS present FROM workflow_runs WHERE project_id = ? AND run_id = ?");
  const deleteRunStatement = prepare("DELETE FROM workflow_runs WHERE project_id = ? AND run_id = ?");
  const deleteLeaseStatement = prepare(
    "DELETE FROM workflow_run_leases WHERE project_id = ? AND run_id = ? AND owner_token = ?",
  );
  const insertLeaseStatement = prepare(
    `INSERT INTO workflow_run_leases(project_id, run_id, owner_pid, owner_token, acquired_at, heartbeat_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const validateLease = (lease: RunLease, runId: string): void => {
    if (lease.projectId !== projectId || lease.runId !== runId || !lease.token) {
      fail("LEASE_LOST", "Workflow run ownership was lost.");
    }
  };

  return {
    save(state, lease) {
      requireOpen();
      validateState(state);
      validateLease(lease, state.runId);
      state.updatedAt = new Date(now()).toISOString();
      validateState(state);
      const stateJson = JSON.stringify(state);
      const summary = summarizePersistedRun(projectId, state);
      db.exec("BEGIN IMMEDIATE");
      try {
        const storedLease = leaseStatement.get(projectId, state.runId) as { owner_token: string } | undefined;
        if (!storedLease || storedLease.owner_token !== lease.token)
          fail("LEASE_LOST", "Workflow run ownership was lost.");
        const existing = existingRunStatement.get(projectId, state.runId) as { session_id: string | null } | undefined;
        if (existing && (existing.session_id ?? undefined) !== state.sessionId) {
          fail("SESSION_REBIND", "Workflow run session ownership cannot be changed.");
        }
        saveRunStatement.run(
          projectId,
          summary.runId,
          summary.sessionId ?? null,
          summary.workflowName,
          summary.status,
          summary.currentPhase ?? null,
          summary.startedAt,
          summary.updatedAt,
          summary.completedAt ?? null,
          summary.durationMs ?? null,
          summary.agentCounts.total,
          summary.agentCounts.running,
          summary.agentCounts.done,
          summary.agentCounts.error,
          summary.tokenUsage?.input ?? null,
          summary.tokenUsage?.output ?? null,
          summary.tokenUsage?.total ?? null,
          summary.tokenUsage?.cost ?? null,
          summary.tokenUsage?.cacheRead ?? null,
          summary.tokenUsage?.cacheWrite ?? null,
          summary.hasScript ? 1 : 0,
          WORKFLOW_PAYLOAD_VERSION,
        );
        savePayloadStatement.run(projectId, state.runId, stateJson);
        updateLeaseHeartbeatStatement.run(now(), projectId, state.runId, lease.token);
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    getSummary(runId) {
      requireOpen();
      validString(runId, "run id");
      const row = getSummaryStatement.get(projectId, runId) as SummaryRow | undefined;
      return row ? decodeSummary(row) : null;
    },

    load(runId) {
      requireOpen();
      validString(runId, "run id");
      const row = loadStatement.get(projectId, runId) as
        | { session_id: string | null; payload_version: number; state_json: string }
        | undefined;
      if (!row) return null;
      if (row.payload_version !== WORKFLOW_PAYLOAD_VERSION)
        fail("CORRUPT_RUN", "A workflow run payload version is invalid.");
      let state: PersistedRunState;
      try {
        state = JSON.parse(row.state_json) as PersistedRunState;
      } catch {
        fail("CORRUPT_RUN", "A workflow run payload is malformed.");
      }
      try {
        validateState(state);
      } catch (error) {
        throw new WorkflowPersistenceError("CORRUPT_RUN", "A workflow run payload is invalid.", error);
      }
      if (state.runId !== runId || state.sessionId !== (row.session_id ?? undefined)) {
        fail("CORRUPT_RUN", "A workflow run payload identity is invalid.");
      }
      return state;
    },

    listSummaries(sessionId) {
      requireOpen();
      validOptionalString(sessionId, "session id");
      const rows = (sessionId === undefined
        ? listAllStatement.all(projectId)
        : listSessionStatement.all(projectId, sessionId)) as unknown as SummaryRow[];
      return rows.map(decodeSummary);
    },

    delete(runId, lease) {
      requireOpen();
      validString(runId, "run id");
      validateLease(lease, runId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const exists = runExistsStatement.get(projectId, runId);
        if (!exists) {
          db.exec("ROLLBACK");
          return "not_found";
        }
        const stored = leaseStatement.get(projectId, runId) as { owner_token: string } | undefined;
        if (!stored || stored.owner_token !== lease.token) {
          db.exec("ROLLBACK");
          return "leased";
        }
        deleteRunStatement.run(projectId, runId);
        deleteLeaseStatement.run(projectId, runId, lease.token);
        db.exec("COMMIT");
        return "deleted";
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    acquireRunLease(runId, mode) {
      requireOpen();
      validString(runId, "run id");
      if (mode !== "new" && mode !== "existing") fail("INVALID_LEASE_MODE", "Invalid workflow run lease mode.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const runExists = Boolean(runExistsStatement.get(projectId, runId));
        if ((mode === "new" && runExists) || (mode === "existing" && !runExists)) {
          db.exec("ROLLBACK");
          return null;
        }
        const timestamp = now();
        const existing = leaseStatement.get(projectId, runId) as
          | { owner_pid: number; owner_token: string; heartbeat_at_ms: number }
          | undefined;
        if (existing) {
          const fresh = timestamp - existing.heartbeat_at_ms <= RUN_LEASE_STALE_AFTER_MS;
          if (fresh && isPidAlive(existing.owner_pid)) {
            db.exec("ROLLBACK");
            return null;
          }
          deleteLeaseStatement.run(projectId, runId, existing.owner_token);
        }
        const token = randomUUID();
        insertLeaseStatement.run(projectId, runId, ownerPid, token, new Date(timestamp).toISOString(), timestamp);
        db.exec("COMMIT");
        return { projectId, runId, token };
      } catch (error) {
        rollback(db);
        throw error;
      }
    },

    renewRunLease(lease) {
      requireOpen();
      validateLease(lease, lease.runId);
      const result = updateLeaseHeartbeatStatement.run(now(), projectId, lease.runId, lease.token);
      return result.changes === 1;
    },

    releaseRunLease(lease) {
      requireOpen();
      validateLease(lease, lease.runId);
      deleteLeaseStatement.run(projectId, lease.runId, lease.token);
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
