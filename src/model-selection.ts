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

/** Synchronous snapshot of models that Pi can use in the current session. */
export interface AvailableModelSource {
  getAvailable(): readonly Model<Api>[];
}

/** One model entry from Pi's resolved session scope. */
export interface WorkflowScopedModel {
  model: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
}

/** Immutable available-model view constrained by Pi's current session scope. */
export interface WorkflowModelScopeSnapshot extends AvailableModelSource {
  /** True when Pi supplied a non-empty allowlist or an incompatible scope. */
  readonly restricted: boolean;
  /** Return the scope-pinned effort for an admitted model, when one exists. */
  scopedThinkingLevel(model: Model<Api>): ModelThinkingLevel | undefined;
}

/** Admission-time scope facts retained for diagnostics without changing identity. */
export interface WorkflowModelScopeProvenance {
  restricted: boolean;
  pinnedEffort?: ModelThinkingLevel;
}

/** @deprecated Use AvailableModelSource. The source now exposes available models only. */
export type ModelRegistrySource = AvailableModelSource;

export interface ResolvedWorkflowModel extends WorkflowModelSnapshot {
  modelObject: Model<Api>;
}

export function canonicalModelSpec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function listAvailableModels(source: AvailableModelSource | undefined): Model<Api>[] {
  if (!source) return [];
  try {
    return [...source.getAvailable()];
  } catch {
    return [];
  }
}

const MODEL_THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isModelLike(value: unknown): value is Model<Api> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { provider?: unknown; id?: unknown };
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  );
}

function isWorkflowScopedModel(value: unknown): value is WorkflowScopedModel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { model?: unknown; thinkingLevel?: unknown };
  return (
    isModelLike(candidate.model) &&
    (candidate.thinkingLevel === undefined ||
      (typeof candidate.thinkingLevel === "string" &&
        MODEL_THINKING_LEVELS.has(candidate.thinkingLevel as ModelThinkingLevel)))
  );
}

function scopeIdentity(model: Model<Api>): string {
  return canonicalModelSpec(model).toLowerCase();
}

function emptyScopeSnapshot(restricted: boolean): WorkflowModelScopeSnapshot {
  const models = Object.freeze([]) as readonly Model<Api>[];
  return {
    restricted,
    getAvailable: () => [...models],
    scopedThinkingLevel: () => undefined,
  };
}

/**
 * Build a copied, immutable model-selection view from Pi's availability and
 * session scope snapshots. An absent or malformed scope fails closed; an
 * empty scope is Pi's documented unrestricted state.
 */
export function createWorkflowModelScopeSnapshot(
  availableSource: AvailableModelSource | undefined,
  scopedModels?: unknown,
): WorkflowModelScopeSnapshot {
  if (!Array.isArray(scopedModels) || !scopedModels.every(isWorkflowScopedModel)) {
    return emptyScopeSnapshot(true);
  }

  const available = listAvailableModels(availableSource).filter(isModelLike);
  if (scopedModels.length === 0) {
    const models = Object.freeze([...available]) as readonly Model<Api>[];
    return {
      restricted: false,
      getAvailable: () => [...models],
      scopedThinkingLevel: () => undefined,
    };
  }

  const availableByIdentity = new Map(available.map((model) => [scopeIdentity(model), model]));
  const selected: Model<Api>[] = [];
  const pinned = new Map<string, ModelThinkingLevel | undefined>();
  const seen = new Set<string>();
  for (const scoped of scopedModels) {
    const identity = scopeIdentity(scoped.model);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const availableModel = availableByIdentity.get(identity);
    if (!availableModel) continue;
    selected.push(availableModel);
    pinned.set(identity, scoped.thinkingLevel);
  }

  const models = Object.freeze([...selected]) as readonly Model<Api>[];
  return {
    restricted: true,
    getAvailable: () => [...models],
    scopedThinkingLevel: (model) => pinned.get(scopeIdentity(model)),
  };
}

/** @deprecated Use listAvailableModels. */
export const listRegisteredModels = listAvailableModels;

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
 * Resolve only a concrete model currently available to Pi. Exact provider/model
 * identity wins; a bare id or display name is accepted only when it has one match.
 */
export function resolveAvailableModel(identifier: string, source: AvailableModelSource | undefined): Model<Api> {
  const requested = typeof identifier === "string" ? identifier.trim() : "";
  const available = listAvailableModels(source);
  if (!requested) throw modelSelectionError("Workflow Model requires a non-empty available model identifier.");
  if (!available.length) {
    throw modelSelectionError(
      `Workflow model "${requested}" is unavailable because Pi reported no available models. ` +
        "Choose a model available in the current Pi session.",
    );
  }

  const normalized = requested.toLowerCase();
  const exact = available.filter((model) => canonicalModelSpec(model).toLowerCase() === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw modelSelectionError(
      `Workflow model "${requested}" is ambiguous among Pi's available models: ${modelListText(exact)}. ` +
        "Use the exact provider/modelId.",
      { requested, matches: exact.map(canonicalModelSpec) },
    );
  }

  if (requested.includes("/")) {
    throw modelSelectionError(
      `Workflow model "${requested}" is not currently available in Pi. Choose an available provider/modelId.`,
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
      `Bare workflow model name "${requested}" is ambiguous. Matching available models: ${modelListText(matches)}. ` +
        "Use the exact provider/modelId.",
      { requested, matches: matches.map(canonicalModelSpec) },
    );
  }

  throw modelSelectionError(
    `Workflow model "${requested}" is not currently available in Pi. Choose an available provider/modelId.`,
    { requested, available: available.map(canonicalModelSpec) },
  );
}

/** @deprecated Use resolveAvailableModel. Resolution is available-only. */
export const resolveRegisteredModel = resolveAvailableModel;

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
        "Choose another available model.",
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
  registry?: AvailableModelSource;
  modelScope?: Pick<WorkflowModelScopeSnapshot, "scopedThinkingLevel">;
}

/** Resolve and snapshot a run-owned default pair at admission. */
export function resolveWorkflowModel(options: ResolveWorkflowModelOptions): ResolvedWorkflowModel {
  const setting = options.setting;
  let model: Model<Api>;
  if (setting?.model) {
    model = resolveAvailableModel(setting.model, options.registry);
  } else if (setting === null || setting === undefined) {
    if (options.sessionModel) {
      model = options.modelScope
        ? resolveAvailableModel(canonicalModelSpec(options.sessionModel), options.registry)
        : options.sessionModel;
    } else if (options.sessionModelId) {
      model = resolveAvailableModel(options.sessionModelId, options.registry);
    } else {
      throw modelSelectionError(
        "Workflow could not determine the current Pi session model. " +
          "Select an available Workflow Model or start the run from a model-backed Pi session.",
      );
    }
  } else {
    throw modelSelectionError(
      "Workflow Model setting is invalid. Choose an available provider/modelId or session inheritance.",
    );
  }

  const scopedEffort = setting?.model ? options.modelScope?.scopedThinkingLevel(model) : undefined;
  const effort =
    setting && setting.effort !== undefined
      ? validateModelEffort(model, setting.effort, "Configured Workflow effort")
      : scopedEffort !== undefined
        ? validateModelEffort(model, scopedEffort, "Pi-scoped Workflow effort")
        : defaultModelEffort(model, options.sessionEffort);
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}

/** Rehydrate a persisted pair without consulting current Workflow settings. */
export function resolveWorkflowModelSnapshot(
  snapshot: WorkflowModelSnapshot,
  options: Pick<ResolveWorkflowModelOptions, "sessionModel" | "registry" | "modelScope"> = {},
): ResolvedWorkflowModel {
  const sessionMatches =
    options.sessionModel && canonicalModelSpec(options.sessionModel).toLowerCase() === snapshot.model.toLowerCase();
  const model =
    !options.modelScope && sessionMatches && options.sessionModel
      ? options.sessionModel
      : resolveAvailableModel(snapshot.model, options.registry);
  const effort = validateModelEffort(model, snapshot.effort, "Persisted Workflow effort");
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}

/** Resolve an agent's independent partial model/effort override. */
export function resolveAgentModelOverride(
  base: ResolvedWorkflowModel,
  override: { model?: string; effort?: ModelThinkingLevel },
  registry: AvailableModelSource | undefined,
  modelScope?: Pick<WorkflowModelScopeSnapshot, "scopedThinkingLevel">,
): ResolvedWorkflowModel {
  const model = override.model === undefined ? base.modelObject : resolveAvailableModel(override.model, registry);
  const scopedEffort = override.model === undefined ? undefined : modelScope?.scopedThinkingLevel(model);
  const effort =
    override.effort !== undefined
      ? validateModelEffort(model, override.effort, "Requested agent effort")
      : scopedEffort !== undefined
        ? validateModelEffort(model, scopedEffort, "Pi-scoped agent effort")
        : override.model === undefined
          ? base.effort
          : clampThinkingLevel(model, base.effort);
  return { modelObject: model, model: canonicalModelSpec(model), effort };
}
