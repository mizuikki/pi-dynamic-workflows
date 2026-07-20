import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPluginModelRuntime } from "./model-runtime.js";

/**
 * Availability surface for UI/guidelines.
 * Upstream ModelRegistry.getAvailable() is synchronous (snapshot).
 * ModelRuntime.getAvailable() is asynchronous.
 */
export interface ModelAvailabilitySource {
  getAvailable(): readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
}

function reportAvailabilityFailure(error: unknown): void {
  console.warn(`[workflow] unable to read available models: ${error instanceof Error ? error.message : String(error)}`);
}

/** Best-effort synchronous snapshot: arrays only; Promises are not treated as data. */
export function getAvailableModelsSync(source: ModelAvailabilitySource): readonly Model<Api>[] {
  try {
    const models = source.getAvailable();
    if (models && typeof (models as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(models).catch(reportAvailabilityFailure);
      return [];
    }
    return Array.isArray(models) ? models : [];
  } catch (error) {
    reportAvailabilityFailure(error);
    return [];
  }
}

/** Resolve the authenticated/available model list for async callers. */
export async function getAvailableModels(source: ModelAvailabilitySource): Promise<readonly Model<Api>[]> {
  try {
    const models = await source.getAvailable();
    return Array.isArray(models) ? models : [];
  } catch (error) {
    reportAvailabilityFailure(error);
    return [];
  }
}

let defaultRuntimePromise: Promise<ModelRuntime> | undefined;

function getDefaultRuntime(): Promise<ModelRuntime> {
  if (!defaultRuntimePromise) {
    defaultRuntimePromise = createPluginModelRuntime({ allowModelNetwork: false });
  }
  return defaultRuntimePromise;
}

function availabilityFromRuntime(runtime: ModelRuntime): ModelAvailabilitySource {
  return {
    getAvailable: () => runtime.getAvailable(),
  };
}

function availabilityFromRegistry(registry: ModelRegistry): ModelAvailabilitySource {
  return {
    getAvailable: () => registry.getAvailable(),
  };
}

async function resolveDefaultAvailabilitySource(): Promise<ModelAvailabilitySource> {
  return availabilityFromRuntime(await getDefaultRuntime());
}

export function listAvailableModelSpecs(source?: ModelAvailabilitySource): string[] {
  if (!source) {
    // Sync path without a host registry: no blocking ModelRuntime.create.
    return [];
  }
  return getAvailableModelsSync(source).map((model) => `${model.provider}/${model.id}`);
}

export async function listAvailableModelSpecsAsync(
  source?: ModelAvailabilitySource | ModelRegistry | ModelRuntime,
): Promise<string[]> {
  let availability: ModelAvailabilitySource;
  if (!source) {
    availability = await resolveDefaultAvailabilitySource();
  } else if (
    typeof (source as ModelRuntime).getModels === "function" &&
    typeof (source as ModelRuntime).getAvailable === "function"
  ) {
    // ModelRuntime: prefer async getAvailable for auth-aware listing.
    availability = availabilityFromRuntime(source as ModelRuntime);
  } else if (
    typeof (source as ModelRegistry).getAll === "function" &&
    typeof (source as ModelRegistry).getAvailable === "function"
  ) {
    availability = availabilityFromRegistry(source as ModelRegistry);
  } else {
    availability = source as ModelAvailabilitySource;
  }
  return (await getAvailableModels(availability)).map((model) => `${model.provider}/${model.id}`);
}
