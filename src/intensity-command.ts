/**
 * Standing workflow intensity auto-arms substantive interactive messages and
 * adds guidance for fan-out breadth and explicit runtime caps.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type IntensityLevel = "off" | "high" | "ultra";

export interface IntensityState {
  level: IntensityLevel;
}

export function createIntensityState(): IntensityState {
  return { level: "off" };
}

const HIGH_DIRECTIVE =
  "Intensity: HIGH. Be thorough — use a few parallel reviewers/perspectives and an adversarial verify pass (see verify()/judgePanel()); set a moderate tokenBudget and maxAgents on the workflow tool call.";
const ULTRA_DIRECTIVE =
  "Intensity: ULTRA. Be exhaustive — fan out widely (more reviewers/judges, deeper loopUntilDry rounds, a completenessCheck at the end), and use the admitted Workflow Model for synthesis unless the user explicitly requests a temporary model/effort override. This can spend a lot of tokens quickly, so set explicit caps you're comfortable paying for (a generous but bounded tokenBudget and a high maxAgents) on the workflow tool call rather than leaving them unbounded.";
const HIGH_TEXT_DIRECTIVE =
  "Intensity: HIGH. Be thorough — use a few parallel text reviewers/perspectives and a final prose synthesis; use loopUntilDry(), retry(), or gate() when useful, and set a moderate tokenBudget and maxAgents on the workflow tool call. Workflow structured output is disabled, so do not rely on verify() or judgePanel().";
const ULTRA_TEXT_DIRECTIVE =
  "Intensity: ULTRA. Be exhaustive — fan out widely with text-safe reviewers, deeper loopUntilDry rounds, and a final prose completeness pass; use retry() or gate() where useful, and use the admitted Workflow Model for synthesis unless the user explicitly requests a temporary override. This can spend a lot of tokens quickly, so set explicit caps you're comfortable paying for (a generous but bounded tokenBudget and a high maxAgents) on the workflow tool call. Workflow structured output is disabled, so do not rely on completenessCheck(), verify(), or judgePanel().";

/** Extra orchestration guidance appended to a forced-workflow prompt. */
export function intensityDirective(level: IntensityLevel, structuredOutputEnabled = false): string | undefined {
  if (level === "high") return structuredOutputEnabled ? HIGH_DIRECTIVE : HIGH_TEXT_DIRECTIVE;
  if (level === "ultra") return structuredOutputEnabled ? ULTRA_DIRECTIVE : ULTRA_TEXT_DIRECTIVE;
  return undefined;
}

/** Ignore terse acknowledgements and slash commands for standing intensity. */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  return t.length >= 16 && !t.startsWith("/");
}

export async function handleWorkflowIntensityCommand(
  pi: ExtensionAPI,
  state: IntensityState,
  args: string,
  _ctx: ExtensionCommandContext,
): Promise<void> {
  const arg = args.trim().toLowerCase();
  const say = (content: string) => pi.sendMessage({ customType: "workflow-intensity", content, display: true });
  if (arg === "off" || arg === "high" || arg === "ultra") {
    state.level = arg;
    await say(
      arg === "off"
        ? "Workflow intensity off — messages are no longer auto-armed as workflows."
        : `Workflow intensity ${arg} — substantive messages now auto-arm a workflow (${arg === "ultra" ? "exhaustive" : "thorough"} fan-out). Use /workflow intensity off to stop.`,
    );
    return;
  }
  await say(`Workflow intensity is currently "${state.level}". Usage: /workflow intensity off | high | ultra`);
}
