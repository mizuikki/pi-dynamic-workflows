import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** The small availability surface shared by upstream Pi and the local fork. */
export interface ModelAvailabilitySource {
  getAvailable(): readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
  getAvailableSync?(): readonly Model<Api>[];
}

function reportAvailabilityFailure(error: unknown): void {
  console.warn(`[workflow] unable to read available models: ${error instanceof Error ? error.message : String(error)}`);
}

/** Return a best-effort synchronous snapshot without treating a Promise as data. */
export function getAvailableModelsSync(source: ModelAvailabilitySource): readonly Model<Api>[] {
  try {
    if (typeof source.getAvailableSync === "function") {
      const models = source.getAvailableSync();
      return Array.isArray(models) ? models : [];
    }
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

/** Resolve the authenticated model list for UI and other asynchronous callers. */
export async function getAvailableModels(source: ModelAvailabilitySource): Promise<readonly Model<Api>[]> {
  try {
    const models = await source.getAvailable();
    return Array.isArray(models) ? models : [];
  } catch (error) {
    reportAvailabilityFailure(error);
    return [];
  }
}

function createDefaultAvailabilitySource(): ModelAvailabilitySource {
  const agentDir = getAgentDir();
  return ModelRegistry.create(
    AuthStorage.create(join(agentDir, "auth.json")),
    join(agentDir, "models.json"),
  ) as unknown as ModelAvailabilitySource;
}

export function listAvailableModelSpecs(source?: ModelAvailabilitySource): string[] {
  return getAvailableModelsSync(source ?? createDefaultAvailabilitySource()).map(
    (model) => `${model.provider}/${model.id}`,
  );
}

export async function listAvailableModelSpecsAsync(source?: ModelAvailabilitySource): Promise<string[]> {
  return (await getAvailableModels(source ?? createDefaultAvailabilitySource())).map(
    (model) => `${model.provider}/${model.id}`,
  );
}
