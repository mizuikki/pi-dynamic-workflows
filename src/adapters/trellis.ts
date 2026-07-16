/**
 * Optional Trellis context adapter for pi-dynamic-workflows.
 *
 * Read-only: discovers an active task and expands prd/design/implement + jsonl
 * file manifests into a user-prompt prefix. Never creates/starts/archives tasks
 * and never drives Trellis phase state.
 *
 * The optional `trellis_subagent` host tool (see trellis-subagent-tool.ts) reuses
 * this loader + WorkflowAgent for dispatch when the native Trellis extension is
 * absent. Lifecycle remains outside this package.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { SubagentContextLoader } from "../subagent-context.js";

export type TrellisAdapterEnabled = "off" | "auto" | "on";
export type TrellisSubagentToolSetting = "off" | "auto" | "on";

export interface TrellisAdapterSettings {
  /** Default "auto": enable only when `<cwd>/.trellis/` exists. */
  enabled?: TrellisAdapterEnabled;
  /** When a task path is resolved without an Active task line, prepend one. Default true. */
  autoPrependActiveTaskLine?: boolean;
  /**
   * Whether to register the host-facing `trellis_subagent` tool.
   * Default "auto": register only when the adapter is enabled, the project has
   * `.trellis/`, no native Trellis extension path is present, and no tool named
   * `trellis_subagent` is already registered.
   */
  registerSubagentTool?: TrellisSubagentToolSetting;
}

export interface TrellisContextLoaderOptions extends TrellisAdapterSettings {
  /**
   * Optional override for `task.py current` (tests). Returns a repo-relative task
   * path such as `.trellis/tasks/04-17-foo`, or null/undefined when none.
   */
  resolveTaskPyCurrent?: (cwd: string) => string | null | undefined;
  /** Optional warning sink (defaults to console.warn). */
  warn?: (message: string) => void;
}

const TRELLIS_AGENT_JSONL: Record<string, string> = {
  "trellis-implement": "implement.jsonl",
  implement: "implement.jsonl",
  "trellis-check": "check.jsonl",
  check: "check.jsonl",
};

const ACTIVE_TASK_LINE = /^Active task:\s*(.+?)\s*$/m;

export function hasTrellisProject(cwd: string): boolean {
  try {
    return existsSync(join(cwd, ".trellis"));
  } catch {
    return false;
  }
}

export function hasNativeTrellisExtension(cwd: string): boolean {
  return (
    existsSync(join(cwd, ".pi", "extensions", "trellis")) ||
    existsSync(join(cwd, ".pi", "extensions", "trellis.ts")) ||
    existsSync(join(cwd, ".pi", "extensions", "trellis.js")) ||
    existsSync(join(cwd, "extensions", "trellis")) ||
    existsSync(join(cwd, "extensions", "trellis.ts")) ||
    existsSync(join(cwd, "extensions", "trellis.js"))
  );
}

/** Whether the adapter should attach a context loader for this cwd/settings. */
export function shouldEnableTrellisAdapter(cwd: string, settings?: TrellisAdapterSettings): boolean {
  const enabled = settings?.enabled ?? "auto";
  if (enabled === "off") return false;
  if (enabled === "on") return true;
  return hasTrellisProject(cwd);
}

/**
 * Whether the optional `trellis_subagent` tool should be registered.
 * Does not inspect already-registered tools — callers must also check
 * `hasRegisteredTrellisSubagentTool(pi)`.
 */
export function shouldRegisterTrellisSubagentTool(cwd: string, settings?: TrellisAdapterSettings): boolean {
  const mode = settings?.registerSubagentTool ?? "auto";
  if (mode === "off") return false;
  if (!shouldEnableTrellisAdapter(cwd, settings)) return false;
  if (mode === "on") return true;
  // auto: only when project looks like Trellis and native extension files are absent
  if (!hasTrellisProject(cwd)) return false;
  if (hasNativeTrellisExtension(cwd)) return false;
  return true;
}

/** Path predicate for filtering Trellis host extensions out of child sessions. */
export function trellisExtensionPathFilter(pathValue: string): boolean {
  const normalized = normalize(pathValue).replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.pi/extensions/trellis/") ||
    normalized.includes("/extensions/trellis/") ||
    /\/\.pi\/extensions\/trellis\.(ts|js|mjs|cjs)$/.test(normalized) ||
    /\/extensions\/trellis\.(ts|js|mjs|cjs)$/.test(normalized) ||
    normalized.endsWith("/.pi/extensions/trellis") ||
    normalized.endsWith("/extensions/trellis")
  );
}

export function parseActiveTaskLine(prompt: string): string | undefined {
  const match = prompt.match(ACTIVE_TASK_LINE);
  const value = match?.[1]?.trim();
  return value || undefined;
}

/**
 * Resolve a stable Trellis context key for this host session (mirrors native
 * `contextKey` + `adoptKey` semantics closely enough for nested bash env and
 * session-map lookups). Returns undefined when no stable key can be formed.
 */
export function resolveTrellisContextKey(
  cwd: string,
  sessionId?: string,
  options: {
    /** Prefer an existing env key when set (native child / nested host). */
    preferEnv?: boolean;
  } = {},
): string | undefined {
  const preferEnv = options.preferEnv !== false;
  if (preferEnv) {
    const envKey = process.env.TRELLIS_CONTEXT_ID?.trim();
    if (envKey) return sanitizeContextKey(envKey);
  }

  if (sessionId?.trim()) {
    const sanitized = sanitizeContextKey(sessionId);
    // Prefer the canonical pi_ prefix used by native Trellis.
    return `pi_${sanitized}`;
  }

  // Fall back to a single-session adopt key when exactly one session file has a task.
  const adopted = adoptSingleSessionKey(cwd);
  if (adopted) return adopted;

  return undefined;
}

export function createTrellisContextLoader(options: TrellisContextLoaderOptions = {}): SubagentContextLoader {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const autoPrepend = options.autoPrependActiveTaskLine !== false;
  let warnedNative = false;

  return async ({ cwd, agentType, prompt, sessionId }) => {
    if (!shouldEnableTrellisAdapter(cwd, options)) return undefined;

    if (hasNativeTrellisExtension(cwd) && !warnedNative) {
      // Context injection still runs under the native extension. Tool registration
      // is handled separately and skips when native is present.
      warn("[trellis-adapter] native Trellis extension detected; using read-only context injection only");
      warnedNative = true;
    }

    const contextKey = resolveTrellisContextKey(cwd, sessionId);
    const env = contextKey ? { TRELLIS_CONTEXT_ID: contextKey } : undefined;

    const resolved = resolveActiveTaskPath(cwd, prompt, sessionId, options, warn);
    if (!resolved) {
      // Even without a task dir, propagate the context key so nested bash and
      // other Trellis tooling can write/read the session map under a stable id.
      return env ? { env } : undefined;
    }

    const prefixParts: string[] = [];
    if (autoPrepend && !parseActiveTaskLine(prompt)) {
      prefixParts.push(`Active task: ${toRepoRelativeTaskPath(cwd, resolved)}`);
    }
    prefixParts.push(buildTrellisTaskContext(cwd, resolved, agentType));

    return {
      promptPrefix: prefixParts.filter(Boolean).join("\n\n"),
      ...(env ? { env } : {}),
    };
  };
}

export function resolveActiveTaskPath(
  cwd: string,
  prompt: string,
  sessionId: string | undefined,
  options: TrellisContextLoaderOptions = {},
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  const fromPrompt = parseActiveTaskLine(prompt);
  if (fromPrompt) return resolveTaskDirectory(cwd, fromPrompt);

  // TRELLIS_CONTEXT_ID is already a full context key (e.g. pi_<id>, claude_<id>).
  const envKey = process.env.TRELLIS_CONTEXT_ID?.trim();
  if (envKey) {
    const fromEnv = readTaskDirFromSessionKey(cwd, sanitizeContextKey(envKey));
    if (fromEnv) return fromEnv;
  }

  if (sessionId?.trim()) {
    // Match Trellis `_context_key("pi", "session", id)` => `pi_<sanitized>`.
    // Also try the raw sanitized session id for hosts that store bare keys.
    const sanitized = sanitizeContextKey(sessionId);
    const fromSession = readTaskDirFromSessionKey(cwd, `pi_${sanitized}`) ?? readTaskDirFromSessionKey(cwd, sanitized);
    if (fromSession) return fromSession;
  }

  const adopted = adoptSingleSessionTask(cwd, warn);
  if (adopted !== undefined) return adopted ?? undefined;

  const fromTaskPy = (options.resolveTaskPyCurrent ?? defaultResolveTaskPyCurrent)(cwd);
  if (fromTaskPy) return resolveTaskDirectory(cwd, fromTaskPy);

  return undefined;
}

export function buildTrellisTaskContext(cwd: string, taskDir: string, agentType?: string): string {
  const dir = resolveTaskDirectory(cwd, taskDir);
  if (!dir) {
    return ["## Trellis Task Context", "Task directory: (unresolved)", "", "### prd.md", "(missing)"].join("\n");
  }
  const prd = readText(join(dir, "prd.md"));
  const design = readText(join(dir, "design.md"));
  const impl = readText(join(dir, "implement.md"));
  const jsonlName = agentType
    ? (TRELLIS_AGENT_JSONL[agentType] ?? TRELLIS_AGENT_JSONL[normalizeAgentName(agentType)])
    : undefined;

  let spec = "";
  if (jsonlName) {
    const chunks: string[] = [];
    for (const line of readText(join(dir, jsonlName)).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>;
        if (row._example) continue;
        const file = typeof row.file === "string" ? row.file.trim() : "";
        if (!file) continue;
        const abs = resolveSafeProjectPath(cwd, file);
        if (!abs) continue;
        const content = readText(abs);
        if (content) chunks.push(`## ${toRepoRelativePath(cwd, abs)}\n\n${content}`);
      } catch {
        // Skip illegal JSON lines; never block context expansion.
      }
    }
    spec = chunks.join("\n\n---\n\n");
  }

  return [
    "## Trellis Task Context",
    `Task directory: ${toRepoRelativeTaskPath(cwd, dir)}`,
    "",
    "### prd.md",
    prd || "(missing)",
    design ? `\n### design.md\n${design}` : "",
    impl ? `\n### implement.md\n${impl}` : "",
    spec ? `\n### Curated Spec / Research Context\n${spec}` : "",
  ].join("\n");
}

/** True when `.pi/agents/<agent>.md` exists (native isTrellisAgent parity). */
export function isTrellisAgent(cwd: string, agent: string): boolean {
  const name = normalizeAgentName(agent);
  return existsSync(join(cwd, ".pi", "agents", `${name}.md`));
}

export function normalizeTrellisAgentName(agent: string | undefined): string {
  return normalizeAgentName(agent ?? "trellis-implement");
}

function normalizeAgentName(agent: string): string {
  return agent.startsWith("trellis-") ? agent : `trellis-${agent}`;
}

function defaultResolveTaskPyCurrent(cwd: string): string | undefined {
  const script = join(cwd, ".trellis", "scripts", "task.py");
  if (!existsSync(script)) return undefined;
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(py, [script, "current", "--source"], {
      cwd,
      encoding: "utf-8",
      timeout: 1500,
      env: process.env,
      windowsHide: true,
    });
    if (result.error) return undefined;
    const stdout = (result.stdout ?? "").trim();
    if (!stdout) return undefined;
    // `current --source` prints:
    //   Current task: .trellis/tasks/...
    //   Source: ...
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.toLowerCase().startsWith("current task:"));
    if (line) {
      const value = line.slice("current task:".length).trim();
      if (!value || value === "(none)") return undefined;
      return value;
    }
    // Plain `current` style fallback: first non-empty line is the path.
    const first = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (!first || first.toLowerCase().startsWith("source:") || first === "(none)") return undefined;
    return first;
  } catch {
    return undefined;
  }
}

/**
 * Returns:
 * - string when exactly one session has a task (adopt)
 * - null when multiple sessions have tasks (fail closed)
 * - undefined when no session has a task
 */
function adoptSingleSessionTask(cwd: string, warn: (message: string) => void): string | null | undefined {
  const key = adoptSingleSessionKey(cwd, warn);
  if (key === null) return null;
  if (key === undefined) return undefined;
  return readTaskDirFromSessionKey(cwd, key);
}

/**
 * Adopt a single session *key* (not task dir) when exactly one session file has a task.
 * Returns null on multi-session ambiguity (fail closed), undefined when none.
 */
function adoptSingleSessionKey(cwd: string, warn: (message: string) => void = () => {}): string | null | undefined {
  const sessionsDir = join(cwd, ".trellis", ".runtime", "sessions");
  if (!existsSync(sessionsDir)) return undefined;
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }

  const withTasks: string[] = [];
  for (const file of files) {
    const key = file.slice(0, -5);
    const taskDir = readTaskDirFromSessionKey(cwd, key);
    if (taskDir) withTasks.push(key);
  }

  if (withTasks.length === 0) return undefined;
  if (withTasks.length === 1) return withTasks[0];
  warn("[trellis-adapter] multiple sessions have active tasks; refusing to guess (fail closed)");
  return null;
}

function readTaskDirFromSessionKey(cwd: string, key: string): string | undefined {
  try {
    const raw = readFileSync(join(cwd, ".trellis", ".runtime", "sessions", `${key}.json`), "utf-8");
    const parsed = JSON.parse(raw) as { current_task?: unknown };
    const ref = typeof parsed.current_task === "string" ? parsed.current_task.trim() : "";
    if (!ref) return undefined;
    return resolveTaskDirectory(cwd, ref);
  } catch {
    return undefined;
  }
}

function resolveTaskDirectory(cwd: string, ref: string): string | undefined {
  const cleaned = ref.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!cleaned) return undefined;

  let candidate: string;
  if (isAbsolute(cleaned)) {
    candidate = cleaned;
  } else if (cleaned.startsWith(".trellis/")) {
    candidate = join(cwd, cleaned);
  } else if (cleaned.startsWith("tasks/")) {
    candidate = join(cwd, ".trellis", cleaned);
  } else if (cleaned.includes("/")) {
    candidate = join(cwd, cleaned);
  } else {
    candidate = join(cwd, ".trellis", "tasks", cleaned);
  }

  const resolved = resolve(candidate);
  if (!existsSync(resolved)) return undefined;
  // Fail closed: only accept task dirs inside the project cwd.
  if (!isPathInside(cwd, resolved)) return undefined;
  return resolved;
}

/**
 * Resolve a repo-relative path for jsonl expansion. Absolute paths and
 * `..` escapes outside cwd are rejected (fail closed).
 */
function resolveSafeProjectPath(cwd: string, ref: string): string | undefined {
  const cleaned = ref.replace(/\\/g, "/").trim();
  if (!cleaned || isAbsolute(cleaned)) return undefined;
  const resolved = resolve(cwd, cleaned);
  if (!isPathInside(cwd, resolved)) return undefined;
  if (!existsSync(resolved)) return undefined;
  return resolved;
}

function isPathInside(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (rootResolved === targetResolved) return true;
  const rel = relative(rootResolved, targetResolved).replace(/\\/g, "/");
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Convert an absolute path under `cwd` into a repo-relative POSIX path.
 * Returns undefined when the path escapes the project root.
 */
export function toRepoRelativePath(cwd: string, absPath: string): string | undefined {
  const rel = relative(cwd, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel;
}

function toRepoRelativeTaskPath(cwd: string, taskDir: string): string {
  return toRepoRelativePath(cwd, taskDir) ?? taskDir.replace(/\\/g, "/");
}

function sanitizeContextKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || "session";
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
