import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKnownTrellisChild } from "./agent.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export const WORKFLOW_MAIN_RELATIVE_PATH = ".pi/WORKFLOW_MAIN.md";
export const WORKFLOW_MAIN_MARKER = "<!-- pi-dynamic-workflows:workflow-main -->";
export const MAX_WORKFLOW_MAIN_BYTES = 64 * 1024;

const EMPTY_HASH = "-";
const MAIN_PROMPT_ENABLED_KEY = "mainPromptEnabled";

export type WorkflowMainPromptState = "injected" | "ignored" | "skipped" | "unavailable";

export interface WorkflowMainPromptAccessOptions {
  /** The host has already applied Pi's project-trust gate. */
  projectTrusted?: boolean;
  /** An explicit per-run headless opt-in; this does not persist authorization. */
  allowHeadless?: boolean;
}

export interface WorkflowMainPromptDiagnostic {
  path: typeof WORKFLOW_MAIN_RELATIVE_PATH;
  source: "project";
  state: WorkflowMainPromptState;
  reason: string;
  bytes: number;
  characters: number;
  sha256: string;
}

export interface WorkflowMainPromptResult {
  systemPrompt: string;
  diagnostic: WorkflowMainPromptDiagnostic;
}

interface PromptFileReadResult {
  diagnostic: WorkflowMainPromptDiagnostic;
  text?: string;
}

interface ProjectPromptSettings {
  enabled: boolean;
  malformed: boolean;
}

function diagnostic(
  state: WorkflowMainPromptState,
  reason: string,
  bytes = 0,
  characters = 0,
  sha256 = EMPTY_HASH,
): WorkflowMainPromptDiagnostic {
  return {
    path: WORKFLOW_MAIN_RELATIVE_PATH,
    source: "project",
    state,
    reason,
    bytes,
    characters,
    sha256,
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function unchanged(
  systemPrompt: string,
  state: WorkflowMainPromptState,
  reason: string,
  bytes = 0,
  characters = 0,
  sha256 = EMPTY_HASH,
): WorkflowMainPromptResult {
  return { systemPrompt, diagnostic: diagnostic(state, reason, bytes, characters, sha256) };
}

function readFailureReason(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === "ENOENT") return "missing";
  }
  return "read-error";
}

/** Read the user-owned, exact-project opt-in without consulting global settings. */
function readProjectPromptSettings(cwd: string): ProjectPromptSettings {
  try {
    const raw = JSON.parse(readFileSync(workflowProjectPaths(cwd).settingsPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { enabled: false, malformed: true };
    }
    return {
      enabled: (raw as Record<string, unknown>)[MAIN_PROMPT_ENABLED_KEY] === true,
      malformed: false,
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (String((error as { code?: unknown }).code) === "ENOENT") {
        return { enabled: false, malformed: false };
      }
    }
    return { enabled: false, malformed: true };
  }
}

/** Return the exact-project opt-in state without reading the prompt file. */
export function isWorkflowMainPromptEnabled(cwd: string): boolean {
  return readProjectPromptSettings(cwd).enabled;
}

/** Path to the user-owned opt-in for one exact project cwd. */
export function getWorkflowMainPromptSettingsPath(cwd: string): string {
  return workflowProjectPaths(cwd).settingsPath;
}

function writeProjectPromptSettings(cwd: string, settings: Record<string, unknown>): void {
  const path = getWorkflowMainPromptSettingsPath(cwd);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporaryPath = join(dir, `.settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename succeeded or the temporary file was never created.
    }
  }
}

/** Enable the exact-project prompt opt-in, preserving other project settings. */
export function enableWorkflowMainPrompt(cwd: string): void {
  const current = readProjectSettingsObject(cwd);
  writeProjectPromptSettings(cwd, { ...current, [MAIN_PROMPT_ENABLED_KEY]: true });
}

/** Disable the exact-project prompt opt-in without touching global settings. */
export function disableWorkflowMainPrompt(cwd: string): void {
  const path = getWorkflowMainPromptSettingsPath(cwd);
  const current = readProjectSettingsObject(cwd);
  if (!current) return;
  delete current[MAIN_PROMPT_ENABLED_KEY];
  if (Object.keys(current).length === 0) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    return;
  }
  writeProjectPromptSettings(cwd, current);
}

function readProjectSettingsObject(cwd: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(getWorkflowMainPromptSettingsPath(cwd), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return { ...(parsed as Record<string, unknown>) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (String((error as { code?: unknown }).code) === "ENOENT") return {};
    }
    // Do not overwrite an unreadable or malformed user settings file during a
    // disable operation. It is already fail-closed for this feature.
    return undefined;
  }
}

async function readWorkflowMainPromptFile(cwd: string): Promise<PromptFileReadResult> {
  const filePath = join(cwd, WORKFLOW_MAIN_RELATIVE_PATH);
  const projectDir = join(cwd, ".pi");
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const projectDirStats = await lstat(projectDir);
    if (!projectDirStats.isDirectory()) return { diagnostic: diagnostic("unavailable", "project-dir") };

    const linkStats = await lstat(filePath);
    if (linkStats.isSymbolicLink()) return { diagnostic: diagnostic("unavailable", "symlink") };
    if (linkStats.isDirectory()) return { diagnostic: diagnostic("unavailable", "directory") };
    if (!linkStats.isFile()) return { diagnostic: diagnostic("unavailable", "not-regular") };

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) return { diagnostic: diagnostic("unavailable", "not-regular") };
    if (fileStats.size > MAX_WORKFLOW_MAIN_BYTES) {
      return { diagnostic: diagnostic("unavailable", "oversized", fileStats.size) };
    }

    const bytes = Buffer.alloc(fileStats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const actualBytes = bytes.subarray(0, offset);
    const sha256 = hashBytes(actualBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(actualBytes);
    } catch {
      return {
        diagnostic: diagnostic("unavailable", "invalid-utf8", actualBytes.length, 0, sha256),
      };
    }
    const characters = text.length;

    const finalStats = await handle.stat();
    if (finalStats.size !== fileStats.size) {
      return {
        diagnostic: diagnostic("unavailable", "changed-during-read", actualBytes.length, characters, sha256),
      };
    }
    if (offset !== fileStats.size) {
      return { diagnostic: diagnostic("unavailable", "short-read", actualBytes.length, characters, sha256) };
    }
    if (text.trim().length === 0) {
      return {
        diagnostic: diagnostic(
          "ignored",
          text.length === 0 ? "empty" : "whitespace-only",
          bytes.length,
          characters,
          sha256,
        ),
      };
    }

    return {
      diagnostic: diagnostic("injected", "loaded", bytes.length, characters, sha256),
      text,
    };
  } catch (error) {
    return { diagnostic: diagnostic("unavailable", readFailureReason(error)) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Inspect current file metadata without consulting an existing system prompt. */
export async function inspectWorkflowMainPrompt(
  cwd: string,
  access: WorkflowMainPromptAccessOptions = {},
): Promise<WorkflowMainPromptDiagnostic> {
  if (!hasWorkflowMainPromptAccess(cwd, access)) {
    return diagnostic("skipped", "authorization-required");
  }
  return (await readWorkflowMainPromptFile(cwd)).diagnostic;
}

function hasWorkflowMainPromptAccess(cwd: string, access: WorkflowMainPromptAccessOptions): boolean {
  if (access.projectTrusted !== true) return false;
  return access.allowHeadless === true || isWorkflowMainPromptEnabled(cwd);
}

/**
 * Read the project-local main-agent prompt with a bounded descriptor-based read.
 * This intentionally has no cache: each call represents one agent turn.
 */
export async function loadWorkflowMainPrompt(
  cwd: string,
  systemPrompt: string,
  access: WorkflowMainPromptAccessOptions = {},
): Promise<WorkflowMainPromptResult> {
  if (systemPrompt.includes(WORKFLOW_MAIN_MARKER)) {
    return unchanged(systemPrompt, "skipped", "marker-present");
  }

  if (!hasWorkflowMainPromptAccess(cwd, access)) {
    return unchanged(systemPrompt, "skipped", "authorization-required");
  }

  const result = await readWorkflowMainPromptFile(cwd);
  if (!result.text) return { systemPrompt, diagnostic: result.diagnostic };
  if (systemPrompt.includes(result.text)) {
    return {
      systemPrompt,
      diagnostic: { ...result.diagnostic, state: "skipped", reason: "content-present" },
    };
  }

  return {
    systemPrompt: `${systemPrompt}\n\n${WORKFLOW_MAIN_MARKER}\n${result.text}`,
    diagnostic: result.diagnostic,
  };
}

export function formatWorkflowMainPromptDiagnostic(info: WorkflowMainPromptDiagnostic): string {
  return [
    "Workflow main prompt",
    `path=${info.path}`,
    `source=${info.source}`,
    `state=${info.state}`,
    `reason=${info.reason}`,
    `bytes=${info.bytes}`,
    `characters=${info.characters}`,
    `sha256=${info.sha256}`,
  ].join(" ");
}

function statusForBlockedPrompt(state: WorkflowMainPromptState, reason: string): WorkflowMainPromptDiagnostic {
  return diagnostic(state, reason);
}

function isProjectTrusted(ctx: Pick<ExtensionCommandContext, "isProjectTrusted">): boolean {
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function isWorkflowMainPromptAuthorized(
  pi: { getFlag?: ExtensionAPI["getFlag"] },
  ctx: Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">,
): { authorized: boolean; reason?: string } {
  if (!isProjectTrusted(ctx)) return { authorized: false, reason: "untrusted-project" };
  if (pi.getFlag?.("workflow-main-prompt") === true) return { authorized: true };
  const settings = readProjectPromptSettings(ctx.cwd);
  if (settings.enabled) return { authorized: true };
  return { authorized: false, reason: settings.malformed ? "malformed-opt-in" : "opt-in-disabled" };
}

function notifyCommandUsage(ctx: ExtensionCommandContext): void {
  ctx.ui.notify("Usage: /workflows-prompt enable|disable|status", "warning");
}

function notifyMutationUnavailable(ctx: ExtensionCommandContext): void {
  ctx.ui.notify("/workflows-prompt enable|disable requires interactive UI", "warning");
}

/** Register the explicit per-run headless opt-in flag. */
export function registerWorkflowMainPromptFlag(pi: ExtensionAPI): void {
  try {
    pi.registerFlag?.("workflow-main-prompt", {
      type: "boolean",
      description: "Allow this run to load the project workflow main prompt",
      default: false,
    });
  } catch {
    // Older hosts may not expose extension flags; the persistent opt-in remains
    // available in interactive sessions.
  }
}

/** Register the project prompt opt-in and metadata command. */
export function registerWorkflowMainPromptCommand(pi: ExtensionAPI): void {
  try {
    if ((pi.getCommands?.() ?? []).some((command) => command.name === "workflows-prompt")) return;
  } catch {
    // Hosts without command discovery can still register the command.
  }

  pi.registerCommand("workflows-prompt", {
    description: "Enable, disable, or inspect the project workflow main prompt",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const action = args.trim();
      if (action !== "enable" && action !== "disable" && action !== "status") {
        notifyCommandUsage(ctx);
        return;
      }

      const childProcess = isKnownTrellisChild(process.env);
      if (childProcess && action !== "status") {
        ctx.ui.notify("Workflow main prompt is disabled in child sessions", "info");
        return;
      }

      if (action === "enable") {
        if (!isProjectTrusted(ctx)) {
          ctx.ui.notify("Workflow main prompt requires a trusted project", "warning");
          return;
        }
        if (!ctx.hasUI) {
          notifyMutationUnavailable(ctx);
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Enable workflow main prompt?",
          "Allow this exact project to load .pi/WORKFLOW_MAIN.md into the main Pi agent?",
        );
        if (!confirmed) {
          ctx.ui.notify("Workflow main prompt remains disabled", "info");
          return;
        }
        try {
          enableWorkflowMainPrompt(ctx.cwd);
          ctx.ui.notify("Workflow main prompt enabled for this project", "info");
        } catch {
          ctx.ui.notify("Could not save the project workflow prompt setting", "error");
        }
        return;
      }

      if (action === "disable") {
        if (!ctx.hasUI) {
          notifyMutationUnavailable(ctx);
          return;
        }
        try {
          disableWorkflowMainPrompt(ctx.cwd);
          ctx.ui.notify("Workflow main prompt disabled for this project", "info");
        } catch {
          ctx.ui.notify("Could not update the project workflow prompt setting", "error");
        }
        return;
      }

      let info: WorkflowMainPromptDiagnostic;
      if (childProcess) {
        info = statusForBlockedPrompt("skipped", "child-process");
      } else {
        const authorization = isWorkflowMainPromptAuthorized(pi, ctx);
        if (!authorization.authorized) {
          info = statusForBlockedPrompt("skipped", authorization.reason ?? "unauthorized");
        } else {
          // Inspection is deliberately independent of getSystemPrompt(): a
          // marker in the current prompt must not hide current file metadata.
          info = await inspectWorkflowMainPrompt(ctx.cwd, {
            projectTrusted: true,
            allowHeadless: pi.getFlag?.("workflow-main-prompt") === true,
          });
        }
      }
      ctx.ui.notify(formatWorkflowMainPromptDiagnostic(info), info.state === "unavailable" ? "warning" : "info");
    },
  });
}
