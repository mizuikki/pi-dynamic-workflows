import { createFauxCore, type FauxResponseStep, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ExplicitFauxModels {
  provider: string;
  model: Model<any>;
  getModel: ReturnType<typeof createFauxCore>["getModel"];
  setResponses: (responses: FauxResponseStep[]) => void;
  appendResponses: (responses: FauxResponseStep[]) => void;
  getPendingResponseCount: () => number;
  dispose: () => void;
  /** Underlying stream core for registerProvider streamSimple wiring. */
  core: ReturnType<typeof createFauxCore>;
}

export function createExplicitFauxModels(options: Parameters<typeof createFauxCore>[0] = {}): ExplicitFauxModels {
  const core = createFauxCore(options);
  return {
    provider: core.provider,
    model: core.getModel(),
    getModel: core.getModel,
    setResponses: core.setResponses,
    appendResponses: core.appendResponses,
    getPendingResponseCount: core.getPendingResponseCount,
    dispose: () => {},
    core,
  };
}

function providerConfigFromFaux(faux: ExplicitFauxModels) {
  const models = faux.core.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    baseUrl: model.baseUrl,
  }));
  return {
    baseUrl: faux.model.baseUrl,
    api: faux.model.api,
    apiKey: "workflow-explicit-model",
    streamSimple: (model: Model<any>, context: any, options: any) => faux.core.streamSimple(model, context, options),
    models,
  };
}

/** Build a ModelRuntime with the faux provider registered via registerProvider. */
export async function createFauxModelRuntime(faux: ExplicitFauxModels): Promise<ModelRuntime> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider, async () => ({ type: "api_key", key: "workflow-explicit-model" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerProvider(faux.provider, providerConfigFromFaux(faux));
  return runtime;
}

/**
 * Extension-facing ModelRegistry facade wrapping a faux ModelRuntime.
 * Prefer createFauxModelRuntime / createFauxRuntimeBundle for createAgentSession.
 */
export async function createFauxModelRegistry(faux: ExplicitFauxModels): Promise<ModelRegistry> {
  return new ModelRegistry(await createFauxModelRuntime(faux));
}

/** Runtime + registry facade sharing one registered faux provider. */
export async function createFauxRuntimeBundle(faux: ExplicitFauxModels): Promise<{
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
}> {
  const modelRuntime = await createFauxModelRuntime(faux);
  return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}
