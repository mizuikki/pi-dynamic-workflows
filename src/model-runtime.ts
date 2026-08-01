import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Host registry or runtime that can enumerate registered dynamic providers. */
export type RegisteredProviderSource = Pick<
  ModelRegistry,
  "getRegisteredProviderIds" | "getRegisteredProviderConfig"
> & {
  /** Pi 0.81.1 native provider registration; absent in earlier supported Pi versions. */
  getRegisteredNativeProvider?: (providerId: string) => Provider | undefined;
};

/** Plugin-owned runtime surface that accepts both registered-provider forms. */
export type RegisteredProviderTarget = Pick<ModelRuntime, "registerProvider"> & {
  registerNativeProvider(provider: Provider): void;
};

/** Model list surface used by the shared Workflow Model selector. */
export type ModelListSource = {
  getAll(): readonly Model<Api>[];
};

/** Create a plugin-owned ModelRuntime from the standard agentDir auth/models paths. */
export async function createPluginModelRuntime(
  options: { agentDir?: string; modelsPath?: string | null; allowModelNetwork?: boolean } = {},
): Promise<ModelRuntime> {
  const agentDir = options.agentDir ?? getAgentDir();
  const modelsPath = options.modelsPath === undefined ? join(agentDir, "models.json") : options.modelsPath;
  const allowModelNetwork = options.allowModelNetwork ?? true;
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    allowModelNetwork,
  });
}

/**
 * Copy extension-registered legacy configs and native providers into a plugin-owned runtime.
 * Does not unwrap a host ModelRuntime; only the public registration surface is used.
 */
export function copyRegisteredProviders(
  source: RegisteredProviderSource | undefined,
  target: RegisteredProviderTarget,
): void {
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
    if (config) {
      try {
        target.registerProvider(providerId, config);
      } catch (error) {
        console.warn(
          `[workflow] failed to copy registered provider "${providerId}" into child runtime: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      continue;
    }

    let provider: Provider | undefined;
    try {
      provider = source.getRegisteredNativeProvider?.(providerId);
    } catch {
      continue;
    }
    if (!provider) continue;
    try {
      target.registerNativeProvider(provider);
    } catch (error) {
      console.warn(
        `[workflow] failed to copy registered provider "${providerId}" into child runtime: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Adapt ModelRuntime to the getAll() surface used by model selection. */
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
