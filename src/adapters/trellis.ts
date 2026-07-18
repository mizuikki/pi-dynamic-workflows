/**
 * Optional Trellis context adapter for pi-dynamic-workflows.
 *
 * Read-only: discovers an active task, includes bounded task artifacts, and
 * exposes jsonl files as a read-on-demand manifest. Never creates/starts/
 * archives tasks and never drives Trellis phase state.
 *
 * The optional `trellis_subagent` host tool (see trellis-subagent-tool.ts) reuses
 * this loader + WorkflowAgent for dispatch when the native Trellis extension is
 * absent. Lifecycle remains outside this package.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
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

/** Hard ceiling for the complete Trellis prefix sent on the first agent turn. */
export const MAX_TRELLIS_TASK_CONTEXT_BYTES = 128 * 1024;
/** Hard ceiling for any single task artifact included in the prefix. */
export const MAX_TRELLIS_TASK_ARTIFACT_BYTES = 64 * 1024;
/** Hard ceiling for the read-on-demand manifest rendered into the prefix. */
export const MAX_TRELLIS_MANIFEST_INDEX_BYTES = 32 * 1024;

const MAX_TRELLIS_MANIFEST_SOURCE_BYTES = 256 * 1024;
const MAX_TRELLIS_MANIFEST_ENTRIES = 256;

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
  const jsonlName = agentType
    ? (TRELLIS_AGENT_JSONL[agentType] ?? TRELLIS_AGENT_JSONL[normalizeAgentName(agentType)])
    : undefined;
  const manifest = jsonlName ? buildTrellisManifestIndex(cwd, dir, jsonlName) : "";
  const prd = buildBoundedTaskArtifact(cwd, dir, "prd.md", true);
  const design = buildBoundedTaskArtifact(cwd, dir, "design.md", false);
  const impl = buildBoundedTaskArtifact(cwd, dir, "implement.md", false);
  const context = [
    "## Trellis Task Context",
    `Task directory: ${toRepoRelativeTaskPath(cwd, dir)}`,
    manifest,
    prd,
    design,
    impl,
  ]
    .filter(Boolean)
    .join("\n\n");

  return limitUtf8WithNotice(
    context,
    MAX_TRELLIS_TASK_CONTEXT_BYTES,
    `[Trellis task context truncated at ${MAX_TRELLIS_TASK_CONTEXT_BYTES} bytes. Read task artifacts and manifest paths on demand.]`,
  );
}

function buildTrellisManifestIndex(cwd: string, taskDir: string, jsonlName: string): string {
  const manifestPath = join(taskDir, jsonlName);
  const source = readBoundedProjectText(cwd, manifestPath, MAX_TRELLIS_MANIFEST_SOURCE_BYTES);
  if (!source.text.trim() && !source.truncated) return "";

  const entries: string[] = [];
  const seen = new Set<string>();
  let omitted = source.truncated;
  for (const line of source.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (entries.length >= MAX_TRELLIS_MANIFEST_ENTRIES) {
      omitted = true;
      break;
    }
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (row._example) continue;
      const file = typeof row.file === "string" ? row.file.trim() : "";
      if (!file) continue;
      const abs = resolveSafeProjectPath(cwd, file);
      if (!abs || seen.has(abs)) continue;
      const stats = statSync(abs);
      if (!stats.isFile()) continue;
      seen.add(abs);
      const relativePath = toRepoRelativePath(cwd, abs);
      if (!relativePath) continue;
      const reason = normalizeManifestReason(row.reason);
      entries.push(
        `- \`${relativePath}\` (${stats.size} bytes, rev ${fileMetadataRevision(stats)})${reason ? `: ${reason}` : ""}`,
      );
    } catch {
      // Skip illegal JSON lines and unsafe/unreadable paths.
    }
  }
  if (entries.length === 0 && !omitted) return "";
  if (omitted) {
    entries.push(`- ... additional entries omitted; inspect \`${jsonlName}\` directly.`);
  }

  const index = [
    `### Curated Spec / Research Manifest (${jsonlName})`,
    "Referenced files are not inlined. Use each reason to choose relevant files, and prefer targeted searches or ranged reads for large files.",
    ...entries,
  ].join("\n");
  return limitUtf8WithNotice(
    index,
    MAX_TRELLIS_MANIFEST_INDEX_BYTES,
    `[Manifest index truncated at ${MAX_TRELLIS_MANIFEST_INDEX_BYTES} bytes. Inspect ${jsonlName} directly for remaining entries.]`,
  );
}

function buildBoundedTaskArtifact(cwd: string, taskDir: string, fileName: string, required: boolean): string {
  const source = readBoundedProjectText(cwd, join(taskDir, fileName), MAX_TRELLIS_TASK_ARTIFACT_BYTES);
  if (!source.text) return required ? `### ${fileName}\n(missing)` : "";
  const relativePath = toRepoRelativePath(cwd, join(taskDir, fileName)) ?? fileName;
  const bounded = source.truncated
    ? appendUtf8Notice(
        source.text,
        MAX_TRELLIS_TASK_ARTIFACT_BYTES,
        `[${fileName} truncated at ${MAX_TRELLIS_TASK_ARTIFACT_BYTES} bytes. Read ${relativePath} directly for the remainder.]`,
      )
    : source.text;
  return `### ${fileName}\n${bounded}`;
}

function readBoundedProjectText(cwd: string, path: string, maxBytes: number): { text: string; truncated: boolean } {
  const canonical = canonicalProjectPath(cwd, path);
  if (!canonical) return { text: "", truncated: false };
  let fd: number | undefined;
  try {
    const stats = statSync(canonical);
    if (!stats.isFile()) return { text: "", truncated: false };
    fd = openSync(canonical, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    const boundedBytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    const truncated = bytesRead > maxBytes || stats.size > maxBytes;
    return {
      text: truncated ? boundedBytes.toString("utf8").replace(/\uFFFD$/, "") : boundedBytes.toString("utf8"),
      truncated,
    };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors after a best-effort read.
      }
    }
  }
}

function appendUtf8Notice(text: string, maxBytes: number, notice: string): string {
  const suffix = `\n\n${notice}`;
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  return `${truncateUtf8(text, available).text}${suffix}`;
}

function fileMetadataRevision(stats: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return createHash("sha256").update(`${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`).digest("hex").slice(0, 12);
}

function normalizeManifestReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const bounded = bytes
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return { text: bounded, truncated: true };
}

function limitUtf8WithNotice(text: string, maxBytes: number, notice: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return appendUtf8Notice(text, maxBytes, notice);
}

/** True when `.pi/agents/<agent>.md` exists (native isTrellisAgent parity). */
export function isTrellisAgent(cwd: string, agent: string): boolean {
  return readTrellisAgentDefinition(cwd, agent) !== undefined;
}

export function normalizeTrellisAgentName(agent: string | undefined): string {
  return normalizeAgentName(agent ?? "trellis-implement");
}

/** Read a validated project-local Trellis agent definition without following escapes. */
export function readTrellisAgentDefinition(cwd: string, agent: string): string | undefined {
  const name = normalizeAgentName(agent);
  if (!/^trellis-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return undefined;
  const path = canonicalProjectPath(cwd, join(cwd, ".pi", "agents", `${name}.md`));
  if (!path) return undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function normalizeAgentName(agent: string): string {
  const trimmed = agent.trim();
  return trimmed.startsWith("trellis-") ? trimmed : `trellis-${trimmed}`;
}

function defaultResolveTaskPyCurrent(cwd: string): string | undefined {
  const script = canonicalProjectPath(cwd, join(cwd, ".trellis", "scripts", "task.py"));
  if (!script) return undefined;
  try {
    if (!statSync(script).isFile()) return undefined;
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
    const raw = readSafeProjectText(cwd, join(cwd, ".trellis", ".runtime", "sessions", `${key}.json`));
    if (!raw) return undefined;
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

  const resolved = canonicalProjectPath(cwd, candidate);
  if (!resolved) return undefined;
  try {
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a repo-relative path for jsonl expansion. Absolute paths and
 * `..` escapes outside cwd are rejected (fail closed).
 */
function resolveSafeProjectPath(cwd: string, ref: string): string | undefined {
  const cleaned = ref.replace(/\\/g, "/").trim();
  if (!cleaned || isAbsolute(cleaned)) return undefined;
  return canonicalProjectPath(cwd, resolve(cwd, cleaned));
}

function canonicalProjectPath(root: string, target: string): string | undefined {
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalTarget = realpathSync(target);
    return isPathInside(canonicalRoot, canonicalTarget) ? canonicalTarget : undefined;
  } catch {
    return undefined;
  }
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

function readSafeProjectText(cwd: string, path: string): string {
  const safePath = canonicalProjectPath(cwd, path);
  if (!safePath) return "";
  try {
    if (!statSync(safePath).isFile()) return "";
    return readFileSync(safePath, "utf-8");
  } catch {
    return "";
  }
}
