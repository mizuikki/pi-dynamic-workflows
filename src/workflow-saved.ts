/**
 * Save and load reusable workflow commands.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { workflowGlobalSavedDir, workflowProjectPaths } from "./workflow-paths.js";

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
  /** Where this workflow is saved. */
  location: "project" | "global";
  /** Full file path. */
  path: string;
  /** When it was saved. */
  savedAt: string;
}

export interface WorkflowStorage {
  /** Save a workflow. */
  save(workflow: Omit<SavedWorkflow, "path" | "savedAt">, location?: "project" | "global"): SavedWorkflow;
  /** Load a workflow by name. */
  load(name: string, location?: "project" | "global"): SavedWorkflow | null;
  /** List all saved workflows. */
  list(location?: "project" | "global" | "all"): SavedWorkflow[];
  /** Delete a saved workflow. */
  delete(name: string, location?: "project" | "global"): boolean;
}

export interface WorkflowStorageFs {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
  openSync: typeof openSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
}

const defaultFs: WorkflowStorageFs = {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
};

export function isSafeSavedWorkflowName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

export function assertSafeSavedWorkflowName(name: string): void {
  if (!isSafeSavedWorkflowName(name)) {
    throw new Error("Saved workflow name must be a non-empty path-safe name without slashes.");
  }
}

function isSavedWorkflowParameters(value: unknown): value is SavedWorkflow["parameters"] {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (parameter) =>
      parameter !== null &&
      typeof parameter === "object" &&
      !Array.isArray(parameter) &&
      typeof (parameter as { type?: unknown }).type === "string" &&
      ((parameter as { description?: unknown }).description === undefined ||
        typeof (parameter as { description?: unknown }).description === "string") &&
      ((parameter as { required?: unknown }).required === undefined ||
        typeof (parameter as { required?: unknown }).required === "boolean"),
  );
}

export function createWorkflowStorage(cwd: string, fsOverride: Partial<WorkflowStorageFs> = {}): WorkflowStorage {
  const fs = { ...defaultFs, ...fsOverride };
  const paths = workflowProjectPaths(cwd);
  const projectDir = paths.savedDir;
  const globalDir = workflowGlobalSavedDir();

  const ensureDir = (dir: string) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  };

  const workflowPath = (name: string, location: "project" | "global") => {
    assertSafeSavedWorkflowName(name);
    const dir = location === "project" ? projectDir : globalDir;
    return join(dir, `${name}.json`);
  };

  const loadFromFile = (path: string, location: "project" | "global"): SavedWorkflow | null => {
    const read = (candidate: string): Omit<SavedWorkflow, "location" | "path"> | null => {
      try {
        if (!fs.existsSync(candidate)) return null;
        const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
        if (
          !data ||
          typeof data !== "object" ||
          !isSafeSavedWorkflowName(typeof data.name === "string" ? data.name : "") ||
          data.name !== basename(path, ".json") ||
          typeof data.description !== "string" ||
          typeof data.script !== "string" ||
          typeof data.savedAt !== "string" ||
          !Number.isFinite(Date.parse(data.savedAt)) ||
          !isSavedWorkflowParameters(data.parameters)
        ) {
          return null;
        }
        return data as unknown as Omit<SavedWorkflow, "location" | "path">;
      } catch {
        return null;
      }
    };
    const data = read(path) ?? read(`${path}.bak`);
    return data ? { ...data, location, path } : null;
  };

  const writeAtomic = (path: string, value: unknown): void => {
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
      const file = fs.openSync(temporaryPath, "r+");
      try {
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(temporaryPath, path);
      fs.copyFileSync(path, `${path}.bak`);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary write error.
      }
      throw error;
    }
  };

  const deleteArtifacts = (path: string): boolean => {
    let deleted = false;
    // Remove the fallback first so a failed primary unlink cannot resurrect a
    // workflow through loadFromFile()'s backup recovery path.
    for (const candidate of [`${path}.bak`, path]) {
      if (!fs.existsSync(candidate)) continue;
      fs.unlinkSync(candidate);
      deleted = true;
    }
    return deleted;
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      if (
        typeof workflow.description !== "string" ||
        typeof workflow.script !== "string" ||
        !isSavedWorkflowParameters(workflow.parameters)
      ) {
        throw new Error("Saved workflow description, script, or parameters are invalid.");
      }
      const dir = location === "project" ? projectDir : globalDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        path,
        savedAt: new Date().toISOString(),
      };

      writeAtomic(path, saved);
      return saved;
    },

    load(name: string, location?: "project" | "global"): SavedWorkflow | null {
      if (!isSafeSavedWorkflowName(name)) return null;
      if (location) return loadFromFile(workflowPath(name, location), location);
      // Project takes precedence over global.
      const projectPath = workflowPath(name, "project");
      const project = loadFromFile(projectPath, "project");
      if (project) return project;

      const globalPath = workflowPath(name, "global");
      return loadFromFile(globalPath, "global");
    },

    list(scope?: "project" | "global" | "all"): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];

      const seen = new Set<string>();
      const addDir = (dir: string, location: "project" | "global") => {
        if (!fs.existsSync(dir)) return;
        let files: string[];
        try {
          files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
        } catch {
          return;
        }
        for (const file of files) {
          const wf = loadFromFile(join(dir, file), location);
          if (!wf) continue;
          const key = scope === "all" ? `${wf.location}:${wf.name}` : wf.name;
          if (!seen.has(key)) {
            seen.add(key);
            workflows.push(wf);
          }
        }
      };

      // Priority order mirrors load(): project > global.
      if (scope !== "global") addDir(projectDir, "project");
      if (scope !== "project") addDir(globalDir, "global");

      return workflows.sort((a, b) => a.name.localeCompare(b.name));
    },

    delete(name: string, location?: "project" | "global"): boolean {
      if (!isSafeSavedWorkflowName(name)) return false;
      const locations = location ? [location] : (["project", "global"] as const);
      let deleted = false;

      for (const loc of locations) {
        const path = workflowPath(name, loc);
        deleted = deleteArtifacts(path) || deleted;
      }

      return deleted;
    },
  };
}
