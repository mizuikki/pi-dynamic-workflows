import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { workflowDatabasePath } from "./workflow-paths.js";

export const WORKFLOW_DATABASE_SCHEMA_VERSION = 1;
export const WORKFLOW_PAYLOAD_VERSION = 1;
export const WORKFLOW_DATABASE_APPLICATION_ID = 1347375683;
export const WORKFLOW_DATABASE_BUSY_TIMEOUT_MS = 5000;

export class WorkflowPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkflowPersistenceError";
    this.code = code;
  }
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new WorkflowPersistenceError(
      "UNSUPPORTED_NODE_RUNTIME",
      "Workflow persistence requires Node.js 24 or newer.",
    );
  }
}

type DatabaseSyncConstructor = typeof import("node:sqlite")["DatabaseSync"];

export function loadNodeSqlite(version = process.versions.node): DatabaseSyncConstructor {
  assertSupportedNodeRuntime(version);
  try {
    const require = createRequire(import.meta.url);
    return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  } catch (error) {
    throw new WorkflowPersistenceError(
      "SQLITE_UNAVAILABLE",
      "Workflow persistence is unavailable in this Node.js runtime.",
      error,
    );
  }
}

export const WORKFLOW_SCHEMA_DDL = [
  `CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE workflow_runs (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    session_id TEXT,
    workflow_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'running', 'paused', 'completed', 'failed', 'aborted')
    ),
    current_phase TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    agent_total INTEGER NOT NULL CHECK (agent_total >= 0),
    agent_running INTEGER NOT NULL CHECK (agent_running >= 0),
    agent_done INTEGER NOT NULL CHECK (agent_done >= 0),
    agent_error INTEGER NOT NULL CHECK (agent_error >= 0),
    token_input INTEGER CHECK (token_input IS NULL OR token_input >= 0),
    token_output INTEGER CHECK (token_output IS NULL OR token_output >= 0),
    token_total INTEGER CHECK (token_total IS NULL OR token_total >= 0),
    token_cost REAL CHECK (token_cost IS NULL OR token_cost >= 0),
    token_cache_read INTEGER CHECK (token_cache_read IS NULL OR token_cache_read >= 0),
    token_cache_write INTEGER CHECK (token_cache_write IS NULL OR token_cache_write >= 0),
    has_script INTEGER NOT NULL CHECK (has_script IN (0, 1)),
    payload_version INTEGER NOT NULL CHECK (payload_version = 1),
    PRIMARY KEY (project_id, run_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE workflow_run_payloads (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    PRIMARY KEY (project_id, run_id),
    FOREIGN KEY (project_id, run_id)
      REFERENCES workflow_runs(project_id, run_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE workflow_run_leases (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
    owner_token TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= 0),
    PRIMARY KEY (project_id, run_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX workflow_runs_project_session_updated
    ON workflow_runs(project_id, session_id, updated_at DESC)`,
  `CREATE INDEX workflow_runs_project_session_status_updated
    ON workflow_runs(project_id, session_id, status, updated_at DESC)`,
  `CREATE INDEX workflow_runs_project_status
    ON workflow_runs(project_id, status)`,
] as const;

const EXPECTED_OBJECT_NAMES = new Set([
  "projects",
  "workflow_runs",
  "workflow_run_payloads",
  "workflow_run_leases",
  "workflow_runs_project_session_updated",
  "workflow_runs_project_session_status_updated",
  "workflow_runs_project_status",
]);

function scalarNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row && Object.values(row)[0];
  if (typeof value !== "number")
    throw new WorkflowPersistenceError("INVALID_DATABASE", "Workflow database metadata is invalid.");
  return value;
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .replace(/;$/, "")
    .toLowerCase();
}

function validateIntegrity(db: DatabaseSync): void {
  const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
    throw new WorkflowPersistenceError("CORRUPT_DATABASE", "The workflow database failed its integrity check.");
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new WorkflowPersistenceError("CORRUPT_DATABASE", "The workflow database contains invalid references.");
  }
}

export function validateWorkflowDatabase(db: DatabaseSync): void {
  const applicationId = scalarNumber(db, "PRAGMA application_id");
  const userVersion = scalarNumber(db, "PRAGMA user_version");
  if (applicationId !== WORKFLOW_DATABASE_APPLICATION_ID || userVersion !== WORKFLOW_DATABASE_SCHEMA_VERSION) {
    throw new WorkflowPersistenceError(
      "UNSUPPORTED_DATABASE",
      "The workflow database has an unsupported identity or version.",
    );
  }
  validateIntegrity(db);

  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  if (rows.length !== EXPECTED_OBJECT_NAMES.size || rows.some((row) => !EXPECTED_OBJECT_NAMES.has(row.name))) {
    throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database schema contains unexpected objects.");
  }
  const actualSql = new Set(rows.map((row) => normalizeSql(row.sql ?? "")));
  for (const ddl of WORKFLOW_SCHEMA_DDL) {
    if (!actualSql.has(normalizeSql(ddl))) {
      throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database schema does not match schema v1.");
    }
  }

  const tables = db.prepare("PRAGMA table_list").all() as Array<Record<string, unknown>>;
  for (const name of ["projects", "workflow_runs", "workflow_run_payloads", "workflow_run_leases"]) {
    const table = tables.find((row) => row.name === name);
    if (table?.strict !== 1 || table.wr !== 1) {
      throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database table flags do not match schema v1.");
    }
    if ((db.prepare(`PRAGMA table_xinfo(${name})`).all() as unknown[]).length === 0) {
      throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database table metadata is incomplete.");
    }
  }
  for (const name of [
    "workflow_runs_project_session_updated",
    "workflow_runs_project_session_status_updated",
    "workflow_runs_project_status",
  ]) {
    if ((db.prepare(`PRAGMA index_xinfo(${name})`).all() as unknown[]).length === 0) {
      throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database index metadata is incomplete.");
    }
  }
  const runIndexes = db.prepare("PRAGMA index_list(workflow_runs)").all() as Array<Record<string, unknown>>;
  const expectedRunIndexes = new Set([
    "workflow_runs_project_session_updated",
    "workflow_runs_project_session_status_updated",
    "workflow_runs_project_status",
  ]);
  const explicitRunIndexes = runIndexes.filter((row) => row.origin === "c");
  if (
    explicitRunIndexes.length !== expectedRunIndexes.size ||
    explicitRunIndexes.some((row) => !expectedRunIndexes.has(String(row.name)) || row.unique !== 0 || row.partial !== 0)
  ) {
    throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database indexes do not match schema v1.");
  }
  if ((db.prepare("PRAGMA foreign_key_list(workflow_runs)").all() as unknown[]).length !== 1) {
    throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database foreign keys do not match schema v1.");
  }
  if ((db.prepare("PRAGMA foreign_key_list(workflow_run_payloads)").all() as unknown[]).length !== 2) {
    throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database foreign keys do not match schema v1.");
  }
  if ((db.prepare("PRAGMA foreign_key_list(workflow_run_leases)").all() as unknown[]).length !== 1) {
    throw new WorkflowPersistenceError("INVALID_SCHEMA", "The workflow database foreign keys do not match schema v1.");
  }
}

function isEmptyDatabase(db: DatabaseSync): boolean {
  const applicationId = scalarNumber(db, "PRAGMA application_id");
  const userVersion = scalarNumber(db, "PRAGMA user_version");
  const objects = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as {
    count: number;
  };
  return applicationId === 0 && userVersion === 0 && objects.count === 0;
}

function createSchema(db: DatabaseSync): void {
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const ddl of WORKFLOW_SCHEMA_DDL) db.exec(ddl);
    db.exec(`PRAGMA application_id = ${WORKFLOW_DATABASE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${WORKFLOW_DATABASE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original initialization error remains authoritative.
    }
    throw error;
  }
}

function configureRuntimeConnection(db: DatabaseSync, inMemory: boolean): void {
  db.exec("PRAGMA foreign_keys = ON");
  const journalMode = db.prepare("PRAGMA journal_mode = WAL").get() as Record<string, unknown>;
  if (!inMemory && Object.values(journalMode)[0] !== "wal") {
    throw new WorkflowPersistenceError(
      "DATABASE_CONFIGURATION_FAILED",
      "The workflow database could not enable WAL mode.",
    );
  }
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

interface PreparedDatabasePath {
  created: boolean;
  identity?: { dev: number; ino: number };
}

function prepareDatabasePath(path: string): PreparedDatabasePath {
  const home = dirname(path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkflowPersistenceError("INVALID_DATABASE_PATH", "The workflow database path is not a regular file.");
    }
    return { created: false, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    if (error instanceof WorkflowPersistenceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    return { created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return prepareDatabasePath(path);
    throw error;
  }
}

function secureAcceptedDatabasePath(path: string, identity: PreparedDatabasePath["identity"]): void {
  const stat = lstatSync(path);
  if (!identity || stat.isSymbolicLink() || !stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new WorkflowPersistenceError(
      "DATABASE_CHANGED_DURING_VALIDATION",
      "The workflow database path changed during validation.",
    );
  }
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
}

export interface OpenWorkflowDatabaseOptions {
  path?: string;
  nodeVersion?: string;
  Database?: DatabaseSyncConstructor;
}

export function openWorkflowDatabase(options: OpenWorkflowDatabaseOptions = {}): DatabaseSync {
  assertSupportedNodeRuntime(options.nodeVersion);
  const Database = options.Database ?? loadNodeSqlite(options.nodeVersion);
  const path = options.path ?? workflowDatabasePath();
  const inMemory = path === ":memory:";
  let prepared: PreparedDatabasePath = { created: inMemory };
  if (!inMemory) {
    try {
      prepared = prepareDatabasePath(path);
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) throw error;
      throw new WorkflowPersistenceError(
        "DATABASE_PERMISSION_FAILED",
        "The workflow database permissions could not be secured.",
      );
    }
  }

  if (!prepared.created) {
    let validation: DatabaseSync | undefined;
    try {
      const validationPath = pathToFileURL(path);
      validationPath.searchParams.set("mode", "ro");
      validationPath.searchParams.set("immutable", "1");
      validation = new Database(validationPath, {
        readOnly: true,
        timeout: WORKFLOW_DATABASE_BUSY_TIMEOUT_MS,
        allowExtension: false,
      });
      if (!isEmptyDatabase(validation)) validateWorkflowDatabase(validation);
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) throw error;
      throw new WorkflowPersistenceError("DATABASE_OPEN_FAILED", "The workflow database could not be validated.");
    } finally {
      try {
        validation?.close();
      } catch {
        // Preserve the validation failure, if any.
      }
    }

    try {
      secureAcceptedDatabasePath(path, prepared.identity);
    } catch (error) {
      if (error instanceof WorkflowPersistenceError) throw error;
      throw new WorkflowPersistenceError(
        "DATABASE_PERMISSION_FAILED",
        "The workflow database permissions could not be secured.",
      );
    }
  }

  let db: DatabaseSync | undefined;
  try {
    db = new Database(path, { timeout: WORKFLOW_DATABASE_BUSY_TIMEOUT_MS, allowExtension: false });
    if (isEmptyDatabase(db)) createSchema(db);
    else validateWorkflowDatabase(db);
    configureRuntimeConnection(db, inMemory);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the initialization failure.
    }
    if (error instanceof WorkflowPersistenceError) throw error;
    throw new WorkflowPersistenceError(
      "DATABASE_INITIALIZATION_FAILED",
      "The workflow database could not be initialized.",
    );
  }
}
