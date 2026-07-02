/**
 * `/workflows-models` command handler.
 *
 * Uses Pi's built-in `ctx.ui.select()`, `ctx.ui.confirm()`, and `ctx.ui.notify()`
 * to let users view and manage workflow tier configuration.
 *
 * Each tier stores a model plus an optional explicit thinking level.
 * An omitted thinking level means "inherit the current Pi session thinking level".
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { listAvailableModelSpecs } from "./agent.js";
import {
  buildDefaultTierConfig,
  loadModelTierConfig,
  type ModelTierConfig,
  type ModelTierTarget,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";

const THINKING_LEVEL_LABELS = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
} as const satisfies Record<"off" | ThinkingLevel, string>;

const INHERIT_THINKING = "__inherit_current_session__";

/**
 * Register the `/workflows-models` command with Pi.
 */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit workflow tier models and thinking levels (small/medium/big)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const availableModelSpecs = listAvailableModelSpecs(ctx.modelRegistry);
      let config = loadModelTierConfig() ?? buildDefaultTierConfig(currentModel, availableModelSpecs);
      let dirty = false;

      const ensureFresh = (cfg: ModelTierConfig) => {
        config = cfg;
        dirty = true;
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tiers = sortedTierNames(config);
        const menuOptions: string[] = [];

        menuOptions.push("─".repeat(30));
        for (const name of tiers) {
          menuOptions.push(formatTierSummary(name, config.tiers[name]));
        }
        menuOptions.push("─".repeat(30));
        menuOptions.push("Reset to defaults");
        menuOptions.push(dirty ? "Save and exit" : "Exit");

        const choice = await ctx.ui.select("Workflow tier configuration", menuOptions);
        if (!choice) break;

        let handledTierSelection = false;
        for (const name of tiers) {
          if (choice === formatTierSummary(name, config.tiers[name])) {
            const updatedTier = await editSingleTier(ctx, config.tiers[name], name);
            if (updatedTier !== null) {
              ensureFresh({
                ...config,
                tiers: {
                  ...config.tiers,
                  [name]: updatedTier,
                },
              });
            }
            handledTierSelection = true;
            break;
          }
        }
        if (handledTierSelection) continue;

        if (choice === "Reset to defaults") {
          const confirmed = await ctx.ui.confirm(
            "Reset workflow tiers",
            "This will reset every tier to your current Pi model and inherit the session thinking level. Continue?",
          );
          if (confirmed) {
            ensureFresh(buildDefaultTierConfig(currentModel, availableModelSpecs));
            ctx.ui.notify("Tiers reset to defaults. Use 'Save and exit' to persist.", "info");
          }
          continue;
        }

        if (choice === "Save and exit" || choice === "Exit") {
          if (choice === "Save and exit") {
            saveModelTierConfig(config);
            ctx.ui.notify("Workflow tier configuration saved.", "info");
          }
          break;
        }
      }
    },
  });
}

/**
 * Interactive editor for a single tier.
 *
 * Returns the updated tier target, or null if nothing changed.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tier: ModelTierTarget,
  tierName: string,
): Promise<ModelTierTarget | null> {
  let working = { ...tier };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choice = await ctx.ui.select(`Edit "${tierName}" tier`, [
      `Model → ${working.model}`,
      `Thinking level → ${formatThinkingSummary(working)}`,
      "Back",
    ]);

    if (!choice || choice === "Back") break;

    if (choice.startsWith("Model →")) {
      const next = await pickTierModel(ctx, working.model, tierName);
      if (!next || next === working.model) continue;

      const previousThinking = working.thinkingLevel;
      working = { ...working, model: next };
      if (previousThinking) {
        const supported = getSupportedThinkingForSpec(ctx, next);
        if (supported.length > 0 && !supported.includes(previousThinking)) {
          const clamped = clampForTierThinking(ctx, next, previousThinking);
          if (clamped) {
            working.thinkingLevel = clamped;
            ctx.ui.notify(
              `"${tierName}" thinking level adjusted to ${clamped} because ${next} does not support ${previousThinking}.`,
              "info",
            );
          }
        }
      }
      continue;
    }

    if (choice.startsWith("Thinking level →")) {
      const next = await pickTierThinkingLevel(ctx, working, tierName);
      if (next === undefined) continue;
      working = next;
    }
  }

  if (tierTargetsEqual(tier, working)) return null;
  ctx.ui.notify(`"${tierName}" tier → ${working.model} | thinking: ${formatThinkingSummary(working)}`, "info");
  return working;
}

function formatTierSummary(name: string, target: ModelTierTarget): string {
  return `${name} tier → ${target.model} | thinking: ${formatThinkingSummary(target)}`;
}

function formatThinkingSummary(target: ModelTierTarget): string {
  return target.thinkingLevel ? THINKING_LEVEL_LABELS[target.thinkingLevel] : "inherit current session";
}

function tierTargetsEqual(a: ModelTierTarget, b: ModelTierTarget): boolean {
  return a.model === b.model && a.thinkingLevel === b.thinkingLevel;
}

async function pickTierModel(ctx: ExtensionCommandContext, current: string, tierName: string): Promise<string | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const items: SelectItem[] = available.map((m) => ({ value: m, label: m }));

  return ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _keybindings, done) => {
    const container = new Container();
    const titleText = current
      ? `Pick a model for "${tierName}" (current: ${current})`
      : `Pick a model for "${tierName}"`;
    container.addChild(new Text(theme.fg("accent", titleText), 1, 0));
    container.addChild(new Spacer(1));

    const selectTheme: SelectListTheme = {
      selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
      selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    const selectList = new SelectList(items, 12, selectTheme);
    const idx = items.findIndex((i) => i.value === current);
    if (idx >= 0) selectList.setSelectedIndex(idx);

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function pickTierThinkingLevel(
  ctx: ExtensionCommandContext,
  tier: ModelTierTarget,
  tierName: string,
): Promise<ModelTierTarget | undefined> {
  const supported = getSupportedThinkingForSpec(ctx, tier.model);
  const choices = [
    { label: "inherit current session", value: INHERIT_THINKING },
    ...supported.map((level) => ({ label: THINKING_LEVEL_LABELS[level], value: level })),
  ];

  const current = tier.thinkingLevel ?? INHERIT_THINKING;
  const selected = await ctx.ui.select(
    `Thinking level for "${tierName}" (${tier.model})`,
    choices.map((choice) => `${choice.label}${choice.value === current ? "  [current]" : ""}`),
  );

  if (!selected) return undefined;
  const chosen = choices.find(
    (choice) => `${choice.label}${choice.value === current ? "  [current]" : ""}` === selected,
  );
  if (!chosen) return undefined;

  if (chosen.value === INHERIT_THINKING) {
    const { thinkingLevel: _thinkingLevel, ...rest } = tier;
    return rest;
  }
  return { ...tier, thinkingLevel: chosen.value as ThinkingLevel };
}

function getSupportedThinkingForSpec(ctx: ExtensionCommandContext, spec: string): Array<"off" | ThinkingLevel> {
  const model = resolveModelSpec(ctx, spec);
  if (!model) {
    return ["off", "minimal", "low", "medium", "high", "xhigh"];
  }
  return getSupportedThinkingLevels(model) as Array<"off" | ThinkingLevel>;
}

function clampForTierThinking(
  ctx: ExtensionCommandContext,
  spec: string,
  level: ThinkingLevel,
): ThinkingLevel | undefined {
  const model = resolveModelSpec(ctx, spec);
  if (!model) return level;
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

function resolveModelSpec(ctx: ExtensionCommandContext, spec: string): Model<any> | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
  }
  const available = ctx.modelRegistry.getAvailableSync();
  return available.find((m) => m.id === spec) ?? ctx.modelRegistry.getAll().find((m) => m.id === spec);
}
