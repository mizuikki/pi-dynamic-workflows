/**
 * Pluggable subagent context loading for workflow runs.
 *
 * The default is a no-op. Optional adapters (e.g. Trellis) can inject task
 * context into the subagent's user prompt without owning lifecycle/state.
 */

export type SubagentContext = {
  /** Prepended to the user prompt (participates in resume hashing). */
  promptPrefix?: string;
  /** Merged with agentType body / phase guidance as extra role instructions. */
  instructions?: string;
  /**
   * Per-run environment map applied to nested bash tool calls inside the
   * subagent session (e.g. TRELLIS_CONTEXT_ID). Never mutates parent process.env
   * under concurrency — the agent runner installs a per-session interceptor.
   */
  env?: Record<string, string>;
};

export type SubagentContextLoader = (args: {
  cwd: string;
  agentType?: string;
  prompt: string;
  sessionId?: string;
}) => Promise<SubagentContext | undefined>;

/** Default loader: leave prompts and instructions unchanged. */
export const noopSubagentContextLoader: SubagentContextLoader = async () => undefined;

/** Merge loader output into a concrete prompt + instructions pair. */
export function applySubagentContext(
  prompt: string,
  instructions: string | undefined,
  context: SubagentContext | undefined,
): { prompt: string; instructions: string | undefined } {
  if (!context) return { prompt, instructions };

  const nextPrompt = context.promptPrefix?.trim() ? `${context.promptPrefix.trim()}\n\n${prompt}` : prompt;
  const nextInstructions = [instructions, context.instructions?.trim()].filter(Boolean).join("\n\n") || undefined;
  return { prompt: nextPrompt, instructions: nextInstructions };
}

/** Shallow-merge env maps; later entries overwrite earlier ones for the same key. */
export function mergeSubagentEnv(
  base?: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !extra) return undefined;
  const out: Record<string, string> = { ...(base ?? {}) };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key === "string" && key && typeof value === "string") out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when a shell command already sets any of the given env keys. */
export function commandAlreadySetsEnv(command: string, env: Record<string, string>): boolean {
  const head = command.trimStart();
  for (const key of Object.keys(env)) {
    if (!key) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[;&\\n]|&&|\\|\\|)\\s*(?:export\\s+)?${escaped}=|\\benv\\s+.*\\b${escaped}=`, "m");
    if (re.test(head)) return true;
  }
  return false;
}

/** Shell-quote a value for `export KEY='...'` injection. */
export function shellQuoteEnvValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prepend `export KEY=value;` assignments for every env entry that is not already
 * present in the command. Used by the per-session bash interceptor.
 */
export function prependEnvExports(command: string, env: Record<string, string>): string {
  if (!command || !Object.keys(env).length) return command;
  const exports = Object.entries(env)
    .filter(
      ([key, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        typeof value === "string" &&
        !commandAlreadySetsEnv(command, { [key]: value }),
    )
    .map(([key, value]) => `export ${key}=${shellQuoteEnvValue(value)}`)
    .join("; ");
  return exports ? `${exports}; ${command}` : command;
}
