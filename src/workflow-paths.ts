/**
 * Filesystem layout for Pi Workflow Orchestrator state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered project-local state directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflow-orchestrator";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";
export const WORKFLOW_DATABASE_FILENAME = "workflow-orchestrator.sqlite3";

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  savedDir: string;
  settingsPath: string;
}

export function workflowHomeDir(): string {
  return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

export function workflowGlobalSavedDir(): string {
  return join(workflowHomeDir(), "saved");
}

export function workflowDatabasePath(): string {
  return join(workflowHomeDir(), WORKFLOW_DATABASE_FILENAME);
}

export function workflowCanonicalProjectPath(cwd: string): string {
  return resolve(cwd);
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = workflowCanonicalProjectPath(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, key);
  return {
    key,
    rootDir,
    savedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
  };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
