import {
  createFauxCore,
  createModels,
  createProvider,
  type FauxResponseStep,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";

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
