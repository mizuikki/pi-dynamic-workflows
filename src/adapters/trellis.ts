/**
 * Optional Trellis context adapter for Pi Workflow Orchestrator.
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
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SubagentContextLoader } from "../subagent-context.js";

export type TrellisAdapterEnabled = "off" | "auto" | "on";
export type TrellisSubagentToolSetting = "off" | "auto" | "on";

export interface TrellisAdapterSettings {
  /** Default "auto": enable only for a supported Trellis project. */
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
  /** Live host transcript getter used only when the native session id is unavailable. */
  getSessionFile?: () => string | undefined;
  /** Controlled child forwarding only; ambient main-session env is ignored by default. */
  allowEnvContextKey?: boolean;
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

export const SUPPORTED_TRELLIS_PROJECT_VERSION = "1.0.4";

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

export function trellisProjectVersion(cwd: string): string | undefined {
  try {
    const version = readFileSync(join(cwd, ".trellis", ".version"), "utf-8").trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

export function hasSupportedTrellisProject(cwd: string): boolean {
  return hasTrellisProject(cwd) && trellisProjectVersion(cwd) === SUPPORTED_TRELLIS_PROJECT_VERSION;
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
  // The adapter mirrors the frozen supported renderer. An explicit opt-in may
  // enable it within that support matrix, but cannot inject those semantics
  // into a missing or incompatible Trellis project.
  return hasSupportedTrellisProject(cwd);
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
 * Resolve the native Trellis 1.0.4 context key. Native session identity always
 * wins; ambient TRELLIS_CONTEXT_ID is accepted only for an explicitly
 * controlled child path. There is deliberately no singleton-session adoption.
 */
export function resolveTrellisContextKey(
  cwd: string,
  sessionId?: string,
  options: {
    /** Accept a controlled child context key when native identity is absent. */
    preferEnv?: boolean;
    /** Native transcript path fallback when no session id is available. */
    sessionFile?: string;
  } = {},
): string | undefined {
  void cwd;
  const nativeSessionId = sessionId?.trim();
  if (nativeSessionId) return nativeSessionContextKey(nativeSessionId);

  const sessionFile = options.sessionFile?.trim();
  if (sessionFile) return `pi_transcript_${hashContextIdentity(sessionFile)}`;

  if (options.preferEnv === true) {
    const envKey = process.env.TRELLIS_CONTEXT_ID?.trim();
    if (envKey) return normalizeForwardedContextKey(envKey);
  }

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
      warn("[workflow-orchestrator] Native Trellis extension detected; using read-only context injection only");
      warnedNative = true;
    }

    const sessionFile = safeGetSessionFile(options.getSessionFile);
    const contextKey = resolveTrellisContextKey(cwd, sessionId, {
      sessionFile,
      preferEnv: options.allowEnvContextKey === true,
    });
    const env = contextKey ? { TRELLIS_CONTEXT_ID: contextKey } : undefined;

    const resolved = resolveActiveTaskPath(
      cwd,
      prompt,
      sessionId,
      { ...options, getSessionFile: () => sessionFile },
      warn,
    );
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
  _warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  const fromPrompt = parseActiveTaskLine(prompt);
  if (fromPrompt) return resolveTaskDirectory(cwd, fromPrompt);

  const nativeKey = resolveTrellisContextKey(cwd, sessionId, {
    sessionFile: safeGetSessionFile(options.getSessionFile),
  });
  if (nativeKey) {
    const fromNative = readTaskDirFromSessionKey(cwd, nativeKey);
    if (fromNative) return fromNative;
  }

  if (options.allowEnvContextKey === true) {
    const envKey = process.env.TRELLIS_CONTEXT_ID?.trim();
    if (envKey) {
      const fromEnv = readTaskDirFromSessionKey(cwd, normalizeForwardedContextKey(envKey));
      if (fromEnv) return fromEnv;
    }
  }

  const fromTaskPy = (options.resolveTaskPyCurrent ?? defaultResolveTaskPyCurrent)(cwd);
  if (fromTaskPy) return resolveTaskDirectory(cwd, fromTaskPy);

  return undefined;
}

export function buildTrellisTaskContext(cwd: string, taskDir: string, agentType?: string): string {
  const dir = resolveTaskDirectory(cwd, taskDir);
  if (!dir) return "";
  const jsonlName = agentType
    ? (TRELLIS_AGENT_JSONL[agentType] ?? TRELLIS_AGENT_JSONL[normalizeAgentName(agentType)])
    : undefined;
  const displayTaskDir = relative(resolve(cwd), resolve(dir)).replace(/\\/g, "/") || ".";
  const parts = ["## Trellis Task Context", `Task directory: ${displayTaskDir}`];
  if (jsonlName) {
    const index = buildTrellisManifestIndex(cwd, dir, jsonlName);
    if (index) parts.push(index);
  }
  const truncatedArtifacts: string[] = [];
  for (const [name, label] of [
    ["prd.md", "Requirements"],
    ["design.md", "Technical Design"],
    ["implement.md", "Execution Plan"],
  ] as const) {
    const displayPath = `${displayTaskDir}/${name}`;
    const { content, truncated } = readBoundedArtifactDetailed(join(dir, name), displayPath);
    if (truncated) truncatedArtifacts.push(displayPath);
    if (content) parts.push(`### ${displayPath} (${label})\n${content}`);
  }

  return truncateUtf8(
    parts.join("\n\n"),
    MAX_TRELLIS_TASK_CONTEXT_BYTES,
    `[Task context for ${displayTaskDir} exceeded ${MAX_TRELLIS_TASK_CONTEXT_BYTES} bytes; artifact limits applied to ${truncatedArtifacts.join(", ") || "none"}; load the remaining task artifacts and manifest sources on demand.]`,
  );
}

function buildTrellisManifestIndex(cwd: string, taskDir: string, jsonlName: string): string {
  const manifestPath = join(taskDir, jsonlName);
  const sourceBytes = readLimitedBytes(manifestPath, MAX_TRELLIS_MANIFEST_SOURCE_BYTES);
  if (!sourceBytes) return "";
  const sourceTruncated = sourceBytes.length > MAX_TRELLIS_MANIFEST_SOURCE_BYTES;
  let source = new StringDecoder("utf8").write(sourceBytes.subarray(0, MAX_TRELLIS_MANIFEST_SOURCE_BYTES));
  if (sourceTruncated) {
    const lastNewline = source.lastIndexOf("\n");
    source = lastNewline >= 0 ? source.slice(0, lastNewline) : "";
  }
  const rows: string[] = [];
  const seen = new Set<string>();
  let entryLimitReached = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      const rawPath = manifestString(row.file) ?? manifestString(row.path);
      if (!rawPath) continue;
      const entryType = row.type === "directory" ? "directory" : "file";
      const resolved = resolveManifestPath(cwd, rawPath);
      if (!resolved) continue;
      if (seen.has(resolved.path)) continue;
      if (rows.length >= MAX_TRELLIS_MANIFEST_ENTRIES) {
        entryLimitReached = true;
        break;
      }
      seen.add(resolved.path);
      const fields = [`path: ${resolved.path}`, `type: ${entryType}`];
      try {
        const metadata = statSync(resolved.target);
        if (entryType === "file") fields.push(`bytes: ${metadata.size}`);
        fields.push(`revision: ${metadata.mtimeMs}`);
      } catch {
        fields.push("status: missing-or-unreadable");
      }
      fields.push(`reason: ${normalizeManifestReason(row.reason)}`);
      rows.push(`- ${fields.join(" | ")}`);
    } catch {
      // Invalid manifest rows are intentionally ignored.
    }
  }
  if (rows.length === 0 && !sourceTruncated) return "";
  const lines = [`### ${jsonlName} candidate context index (load sources on demand)`, ...rows];
  const limitNotices: string[] = [];
  if (entryLimitReached) {
    limitNotices.push(
      `[Omitted additional entries from ${jsonlName} after ${MAX_TRELLIS_MANIFEST_ENTRIES}; load the manifest on demand.]`,
    );
  }
  if (sourceTruncated) {
    limitNotices.push(
      `[Stopped reading ${jsonlName} after ${MAX_TRELLIS_MANIFEST_SOURCE_BYTES} bytes; load the remainder on demand.]`,
    );
  }
  const combined = [lines.join("\n"), ...limitNotices].join("\n");
  if (Buffer.byteLength(combined, "utf8") <= MAX_TRELLIS_MANIFEST_INDEX_BYTES) return combined;
  return truncateUtf8(
    combined,
    MAX_TRELLIS_MANIFEST_INDEX_BYTES,
    [`[Truncated rendered index for ${jsonlName}; load the manifest on demand.]`, ...limitNotices].join(" "),
  );
}

function readLimitedBytes(path: string, limit: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytesRead = readSync(fd, buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    return buffer.subarray(0, count);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort close after a bounded read.
      }
    }
  }
}

function readBoundedArtifactDetailed(path: string, displayPath: string): { content: string; truncated: boolean } {
  const bytes = readLimitedBytes(path, MAX_TRELLIS_TASK_ARTIFACT_BYTES);
  if (!bytes) return { content: "", truncated: false };
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(bytes) + decoder.end();
  const rawOver = bytes.length > MAX_TRELLIS_TASK_ARTIFACT_BYTES;
  const renderedOver = Buffer.byteLength(text, "utf8") > MAX_TRELLIS_TASK_ARTIFACT_BYTES;
  if (!rawOver && !renderedOver) return { content: text, truncated: false };
  return {
    content: truncateUtf8(
      text,
      MAX_TRELLIS_TASK_ARTIFACT_BYTES,
      `[Truncated ${displayPath} at ${MAX_TRELLIS_TASK_ARTIFACT_BYTES} UTF-8 bytes; load the remainder on demand.]`,
    ),
    truncated: true,
  };
}

function manifestString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeManifestReason(value: unknown): string {
  let reason = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!reason) return "(no reason provided)";
  reason = Buffer.from(reason, "utf8").toString("utf8");
  const codePoints = Array.from(reason);
  if (codePoints.length <= 240) return reason;
  return `${codePoints.slice(0, 237).join("")}...`;
}

function resolveManifestPath(root: string, rawPath: string): { path: string; target: string } | null {
  const normalized = rawPath.trim().replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null;
  let rootPath = resolve(root);
  try {
    rootPath = resolve(realpathSync(root));
  } catch {
    // Use the logical root when it cannot be canonicalized.
  }
  const candidate = resolve(rootPath, normalized);
  if (!isManifestPathInsideRoot(rootPath, candidate)) return null;
  let target = candidate;
  try {
    target = resolve(realpathSync(candidate));
  } catch {
    // Missing paths remain valid manifest metadata rows.
  }
  if (!isManifestPathInsideRoot(rootPath, target)) return null;
  return { path: relative(rootPath, target).replace(/\\/g, "/"), target };
}

function isManifestPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function truncateUtf8(text: string, maxBytes: number, notice: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const suffix = Buffer.from(`\n\n${notice}`, "utf8");
  if (suffix.length >= maxBytes) return new StringDecoder("utf8").write(suffix.subarray(0, maxBytes));
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes - suffix.length)) + suffix.toString("utf8");
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

function hashContextIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function nativeSessionContextKey(sessionId: string): string {
  const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!normalized) return `pi_${hashContextIdentity(sessionId)}`;
  return `pi_${normalized}${normalized === sessionId ? "" : `_${hashContextIdentity(sessionId)}`}`;
}

function normalizeForwardedContextKey(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!normalized) return hashContextIdentity(value);
  return normalized === value ? normalized : `${normalized}_${hashContextIdentity(value)}`;
}

function safeGetSessionFile(getter: (() => string | undefined) | undefined): string | undefined {
  try {
    return getter?.();
  } catch {
    return undefined;
  }
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
