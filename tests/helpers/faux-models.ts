import { createModels, type FauxResponseStep, fauxProvider, type Model, type Models } from "@earendil-works/pi-ai";

export interface ExplicitFauxModels {
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
  provider: string;
  model: Model<any>;
  getModel: ReturnType<typeof fauxProvider>["getModel"];
  setResponses: (responses: FauxResponseStep[]) => void;
  appendResponses: (responses: FauxResponseStep[]) => void;
  getPendingResponseCount: () => number;
}

export function createExplicitFauxModels(options: Parameters<typeof fauxProvider>[0] = {}): ExplicitFauxModels {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    models,
    provider: faux.provider.id,
    model: faux.getModel(),
    getModel: faux.getModel,
    setResponses: faux.setResponses,
    appendResponses: faux.appendResponses,
    getPendingResponseCount: faux.getPendingResponseCount,
  };
}
