/**
 * `/workflows-models` command.
 *
 * The command edits one persisted Workflow Model (model plus optional Pi-owned
 * reasoning effort). A null value explicitly makes the scope inherit the live
 * Pi session model; an absent project value inherits the global value.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  canonicalModelSpec,
  createWorkflowModelScopeSnapshot,
  listAvailableModels,
  type ModelThinkingLevel,
  supportedModelEfforts,
  type WorkflowModelSetting,
} from "./model-selection.js";
import {
  clearWorkflowModelSetting,
  getWorkflowProjectSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from "./workflow-settings.js";

const INHERIT_EFFORT = "Inherit current Pi session effort";

/** Register the `/workflows-models` command with Pi. */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit the global or project Workflow Model",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await openWorkflowModelEditor(ctx);
    },
  });
}

/** Interactive editor, exported for focused command tests. */
export async function openWorkflowModelEditor(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const global = loadWorkflowSettings();
  const project = loadWorkflowSettings({ settingsPath: getWorkflowProjectSettingsPath(cwd) });
  const effective = loadWorkflowSettings({ cwd });

  const choices = [
    `Edit global Workflow Model (${describeSetting(global.workflowModel, ctx.model)})`,
    `Edit project Workflow Model (${describeSetting(project.workflowModel, ctx.model)})`,
    "Global: inherit current Pi session model",
    "Project: inherit current Pi session model",
    "Project: clear override and inherit global",
    "Exit",
  ];

  while (true) {
    const choice = await ctx.ui.select(
      `Workflow Model (effective: ${describeEffectiveSetting(effective.workflowModel, ctx.model)})`,
      choices,
    );
    if (!choice || choice === "Exit") return;

    if (choice.startsWith("Edit global")) {
      const next = await editWorkflowModel(ctx, global.workflowModel);
      if (next !== undefined) {
        saveWorkflowSettings({ workflowModel: next });
        ctx.ui.notify(`Global Workflow Model set to ${describeSetting(next, ctx.model)}.`, "info");
        return;
      }
    } else if (choice.startsWith("Edit project")) {
      const next = await editWorkflowModel(ctx, project.workflowModel);
      if (next !== undefined) {
        saveWorkflowSettings({ workflowModel: next }, { cwd, scope: "project" });
        ctx.ui.notify(`Project Workflow Model set to ${describeSetting(next, ctx.model)}.`, "info");
        return;
      }
    } else if (choice.startsWith("Global:")) {
      saveWorkflowSettings({ workflowModel: null });
      ctx.ui.notify("Global Workflow Model now inherits the current Pi session model.", "info");
      return;
    } else if (choice.startsWith("Project: inherit")) {
      saveWorkflowSettings({ workflowModel: null }, { cwd, scope: "project" });
      ctx.ui.notify("Project Workflow Model now inherits the current Pi session model.", "info");
      return;
    } else if (choice.startsWith("Project: clear")) {
      clearWorkflowModelSetting({ cwd, scope: "project" });
      ctx.ui.notify("Project Workflow Model override cleared; the global value now applies.", "info");
      return;
    }
  }
}

/** Refresh Pi's availability snapshot, then pick a model and its supported effort. */
export async function editWorkflowModel(
  ctx: ExtensionCommandContext,
  current?: WorkflowModelSetting,
): Promise<WorkflowModelSetting | undefined> {
  try {
    await ctx.modelRegistry.refresh();
  } catch {
    // Keep the last availability snapshot when refresh cannot complete.
  }
  const modelScope = createWorkflowModelScopeSnapshot(ctx.modelRegistry, ctx.scopedModels);
  const models = listAvailableModels(modelScope);
  if (!models.length) {
    ctx.ui.notify("No Pi models are currently available. Authenticate or select a model first.", "warning");
    return undefined;
  }

  const modelChoices = models.map((model) => canonicalModelSpec(model));
  const selectedModel = await ctx.ui.select(
    `Pick a Workflow Model${current && current !== null ? ` (current: ${current.model})` : ""}`,
    modelChoices,
  );
  if (!selectedModel) return undefined;

  const model = models.find((candidate) => canonicalModelSpec(candidate) === selectedModel);
  if (!model) return undefined;
  const effort = await chooseEffort(
    ctx,
    model,
    current && current.model === selectedModel ? current.effort : undefined,
  );
  if (effort === undefined) return undefined;
  return effort === null ? { model: selectedModel } : { model: selectedModel, effort };
}

async function chooseEffort(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current?: ModelThinkingLevel,
): Promise<ModelThinkingLevel | null | undefined> {
  const choices = [INHERIT_EFFORT, ...supportedModelEfforts(model)];
  const currentLabel = current ?? INHERIT_EFFORT;
  const selected = await ctx.ui.select(`Effort for ${canonicalModelSpec(model)} (current: ${currentLabel})`, choices);
  if (!selected) return undefined;
  return selected === INHERIT_EFFORT ? null : (selected as ModelThinkingLevel);
}

function describeSetting(setting: WorkflowModelSetting | undefined, sessionModel: Model<Api> | undefined): string {
  if (setting === undefined) return "unset";
  if (setting === null) {
    return sessionModel ? `session (${canonicalModelSpec(sessionModel)})` : "current Pi session";
  }
  return `${setting.model}${setting.effort ? ` @ ${setting.effort}` : " @ session effort"}`;
}

function describeEffectiveSetting(
  setting: WorkflowModelSetting | undefined,
  sessionModel: Model<Api> | undefined,
): string {
  if (setting === undefined) {
    return sessionModel ? `session (${canonicalModelSpec(sessionModel)})` : "current Pi session";
  }
  return describeSetting(setting, sessionModel);
}
