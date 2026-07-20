import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Host registry or runtime that can enumerate registered dynamic providers. */
export type RegisteredProviderSource = Pick<ModelRegistry, "getRegisteredProviderIds" | "getRegisteredProviderConfig">;

/** Model list surface used by resolveModelSpecWithThinking. */
export type ModelListSource = {
  getAll(): readonly Model<Api>[];
};

/** Create a plugin-owned ModelRuntime from the standard agentDir auth/models paths. */
export async function createPluginModelRuntime(
  options: { agentDir?: string; modelsPath?: string | null; allowModelNetwork?: boolean } = {},
): Promise<ModelRuntime> {
  const agentDir = options.agentDir ?? getAgentDir();
  const modelsPath = options.modelsPath === undefined ? join(agentDir, "models.json") : options.modelsPath;
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    allowModelNetwork: options.allowModelNetwork,
  });
}

/**
 * Copy extension-registered provider configs into a plugin-owned runtime.
 * Does not unwrap a host ModelRuntime; only the public registration surface is used.
 */
export function copyRegisteredProviders(source: RegisteredProviderSource | undefined, target: ModelRuntime): void {
  if (!source) return;
  let ids: readonly string[];
  try {
    ids = source.getRegisteredProviderIds();
  } catch {
    return;
  }
  for (const providerId of ids) {
    let config: ReturnType<RegisteredProviderSource["getRegisteredProviderConfig"]>;
    try {
      config = source.getRegisteredProviderConfig(providerId);
    } catch {
      continue;
    }
    if (!config) continue;
    try {
      target.registerProvider(providerId, config);
    } catch (error) {
      console.warn(
        `[workflow] failed to copy registered provider "${providerId}" into child runtime: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Adapt ModelRuntime to the getAll() surface used by model-spec resolution. */
export function modelListFromRuntime(runtime: ModelRuntime): ModelListSource {
  return {
    getAll: () => [...runtime.getModels()],
  };
}

/** Adapt the extension ModelRegistry facade to the same getAll() surface. */
export function modelListFromRegistry(registry: Pick<ModelRegistry, "getAll">): ModelListSource {
  return {
    getAll: () => registry.getAll(),
  };
}
