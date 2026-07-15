import {
  createFauxCore,
  createModels,
  createProvider,
  type FauxResponseStep,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ExplicitFauxModels {
  models: Models;
  provider: string;
  model: Model<any>;
  getModel: ReturnType<typeof createFauxCore>["getModel"];
  setResponses: (responses: FauxResponseStep[]) => void;
  appendResponses: (responses: FauxResponseStep[]) => void;
  getPendingResponseCount: () => number;
  dispose: () => void;
}

export function createExplicitFauxModels(options: Parameters<typeof createFauxCore>[0] = {}): ExplicitFauxModels {
  const core = createFauxCore(options);
  const models = createModels();
  models.setProvider(
    createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream: core.stream, streamSimple: core.streamSimple },
    }),
  );

  const sourceId = `explicit-faux:${core.api}`;
  registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);

  return {
    models,
    provider: core.provider,
    model: core.getModel(),
    getModel: core.getModel,
    setResponses: core.setResponses,
    appendResponses: core.appendResponses,
    getPendingResponseCount: core.getPendingResponseCount,
    dispose: () => {
      unregisterApiProviders(sourceId);
    },
  };
}

/** Build a registry that exercises fork explicit Models and standard Pi providers. */
export function createFauxModelRegistry(faux: ExplicitFauxModels): ModelRegistry {
  const inMemory = ModelRegistry.inMemory as unknown as (auth: AuthStorage, models?: Models) => ModelRegistry;
  const registry = inMemory(AuthStorage.inMemory(), faux.models);
  if (registry.find(faux.provider, faux.model.id)) return registry;

  const provider = faux.models.getProvider(faux.provider);
  if (!provider) throw new Error(`missing faux provider ${faux.provider}`);
  registry.registerProvider(faux.provider, {
    name: provider.name,
    baseUrl: provider.baseUrl ?? "http://workflow-explicit.invalid",
    apiKey: "workflow-explicit-model",
    api: faux.model.api,
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
    models: provider.getModels() as never,
  });
  return registry;
}
