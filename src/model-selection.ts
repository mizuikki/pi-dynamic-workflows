import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

export type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** One persisted Workflow Model override. `null` means session inheritance. */
export type WorkflowModelSetting = null | {
  model: string;
  effort?: ModelThinkingLevel;
};

/** Concrete model/effort pair owned by an admitted workflow run. */
export interface WorkflowModelSnapshot {
  model: string;
  effort: ModelThinkingLevel;
}

export interface ModelRegistrySource {
  getAll(): readonly Model<Api>[];
}

export interface ResolvedWorkflowModel extends WorkflowModelSnapshot {
  modelObject: Model<Api>;
}

export function canonicalModelSpec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function listRegisteredModels(source: ModelRegistrySource | undefined): Model<Api>[] {
  if (!source) return [];
  try {
    return [...source.getAll()];
  } catch {
    return [];
  }
}

function modelSelectionError(message: string, details?: unknown): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.MODEL_SELECTION_ERROR, {
    recoverable: false,
    details,
  });
}

function modelListText(models: readonly Model<Api>[]): string {
  return models.length ? models.map(canonicalModelSpec).join(", ") : "none";
}

/**
 * Resolve only a concrete model registered by Pi. Exact provider/model identity
 * wins; a bare id or display name is accepted only when it has one match.
 */
export function resolveRegisteredModel(identifier: string, source: ModelRegistrySource | undefined): Model<Api> {
  const requested = typeof identifier === "string" ? identifier.trim() : "";
  const available = listRegisteredModels(source);
  if (!requested) throw modelSelectionError("Workflow Model requires a non-empty registered model identifier.");
  if (!available.length) {
    throw modelSelectionError(
      `Workflow model "${requested}" is unavailable because Pi reported no registered models. ` +
        "Choose a model available in the current Pi session.",
    );
  }

  const normalized = requested.toLowerCase();
  const exact = available.filter((model) => canonicalModelSpec(model).toLowerCase() === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw modelSelectionError(
      `Workflow model "${requested}" is ambiguous in Pi's registry: ${modelListText(exact)}. ` +
        "Use the exact provider/modelId.",
      { requested, matches: exact.map(canonicalModelSpec) },
    );
  }

  if (requested.includes("/")) {
    throw modelSelectionError(
      `Workflow model "${requested}" is not registered in Pi's model registry. ` +
        "Choose an available registered provider/modelId.",
      { requested, available: available.map(canonicalModelSpec) },
    );
  }

  const bareMatches = available.filter(
    (model) => model.id.toLowerCase() === normalized || model.name?.trim().toLowerCase() === normalized,
  );
  const unique = new Map(bareMatches.map((model) => [canonicalModelSpec(model).toLowerCase(), model]));
  if (unique.size === 1) return [...unique.values()][0];
  if (unique.size > 1) {
    const matches = [...unique.values()];
    throw modelSelectionError(
      `Bare workflow model name "${requested}" is ambiguous. Matching registered models: ${modelListText(matches)}. ` +
        "Use the exact provider/modelId.",
      { requested, matches: matches.map(canonicalModelSpec) },
    );
  }

  throw modelSelectionError(
    `Workflow model "${requested}" is not registered in Pi's model registry. ` +
      "Choose an available registered provider/modelId.",
    { requested, available: available.map(canonicalModelSpec) },
  );
}

export function supportedModelEfforts(model: Model<Api>): ModelThinkingLevel[] {
  return [...getSupportedThinkingLevels(model)];
}

export function validateModelEffort(
  model: Model<Api>,
  effort: unknown,
  source = "Workflow effort",
): ModelThinkingLevel {
  const supported = supportedModelEfforts(model);
  if (typeof effort !== "string" || !supported.includes(effort as ModelThinkingLevel)) {
    throw modelSelectionError(
      `${source} "${String(effort)}" is unsupported for model "${canonicalModelSpec(model)}". ` +
        `Supported values: ${supported.join(", ") || "none"}. Choose one of those values or change the model.`,
      { model: canonicalModelSpec(model), requestedEffort: effort, supportedEfforts: supported },
    );
  }
  return effort as ModelThinkingLevel;
}

export function defaultModelEffort(model: Model<Api>, inherited?: ModelThinkingLevel): ModelThinkingLevel {
  const supported = supportedModelEfforts(model);
  if (!supported.length) {
    throw modelSelectionError(
      `Pi reported no supported reasoning effort for model "${canonicalModelSpec(model)}". ` +
        "Choose another registered model.",
    );
  }
  if (inherited !== undefined) return clampThinkingLevel(model, inherited);
  return supported[0];
}

export interface ResolveWorkflowModelOptions {
  setting?: WorkflowModelSetting;
  sessionModel?: Model<Api>;
  sessionModelId?: string;
  sessionEffort?: ModelThinkingLevel;
  registry?: ModelRegistrySource;
}

/** Resolve and snapshot a run-owned default pair at admission. */
export function resolveWorkflowModel(options: ResolveWorkflowModelOptions): ResolvedWorkflowModel {
  const setting = options.setting;
  let model: Model<Api>;
  if (setting?.model) {
    model = resolveRegisteredModel(setting.model, options.registry);
  } else if (setting === null || setting === undefined) {
    if (options.sessionModel) {
      model = options.sessionModel;
    } else if (options.sessionModelId) {
      model = resolveRegisteredModel(options.sessionModelId, options.registry);
    } else {
      throw modelSelectionError(
        "Workflow could not determine the current Pi session model. " +
          "Select a registered Workflow Model or start the run from a model-backed Pi session.",
      );
    }
  } else {
    throw modelSelectionError(
      "Workflow Model setting is invalid. Choose a registered provider/modelId or session inheritance.",
    );
  }

  const effort =
    setting && setting.effort !== undefined
      ? validateModelEffort(model, setting.effort, "Configured Workflow effort")
      : defaultModelEffort(model, options.sessionEffort);
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}

/** Rehydrate a persisted pair without consulting current Workflow settings. */
export function resolveWorkflowModelSnapshot(
  snapshot: WorkflowModelSnapshot,
  options: Pick<ResolveWorkflowModelOptions, "sessionModel" | "registry"> = {},
): ResolvedWorkflowModel {
  const sessionMatches =
    options.sessionModel && canonicalModelSpec(options.sessionModel).toLowerCase() === snapshot.model.toLowerCase();
  const model =
    sessionMatches && options.sessionModel
      ? options.sessionModel
      : resolveRegisteredModel(snapshot.model, options.registry);
  const effort = validateModelEffort(model, snapshot.effort, "Persisted Workflow effort");
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}

/** Resolve an agent's independent partial model/effort override. */
export function resolveAgentModelOverride(
  base: ResolvedWorkflowModel,
  override: { model?: string; effort?: ModelThinkingLevel },
  registry: ModelRegistrySource | undefined,
): ResolvedWorkflowModel {
  const model = override.model === undefined ? base.modelObject : resolveRegisteredModel(override.model, registry);
  const effort =
    override.effort !== undefined
      ? validateModelEffort(model, override.effort, "Requested agent effort")
      : override.model === undefined
        ? base.effort
        : clampThinkingLevel(model, base.effort);
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}
