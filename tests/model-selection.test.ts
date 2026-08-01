import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  resolveAgentModelOverride,
  resolveAvailableModel,
  resolveWorkflowModel,
  supportedModelEfforts,
  validateModelEffort,
} from "../src/model-selection.js";

function model(
  provider: string,
  id: string,
  options: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } = {},
): Model<Api> {
  return {
    provider,
    id,
    name: id,
    reasoning: options.reasoning ?? false,
    ...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
  } as Model<Api>;
}

function registry(available: Model<Api>[], all: Model<Api>[] = available) {
  return { getAvailable: () => available, getAll: () => all };
}

test("resolves exact and unique bare available model ids", () => {
  const first = model("provider-a", "shared");
  const second = model("provider-b", "other");
  const source = registry([first, second]);
  assert.equal(resolveAvailableModel("provider-a/shared", source), first);
  assert.equal(resolveAvailableModel("other", source), second);
  assert.throws(() => resolveAvailableModel("shared", registry([first, model("provider-b", "shared")])), {
    code: "MODEL_SELECTION_ERROR",
  });
  assert.throws(() => resolveAvailableModel("provider-a/missing", source), { code: "MODEL_SELECTION_ERROR" });
});

test("never resolves a model that is absent from Pi's available snapshot", () => {
  const available = model("provider", "available");
  const registeredOnly = model("provider", "registered-only");
  const source = registry([available], [available, registeredOnly]);

  assert.equal(resolveAvailableModel("provider/available", source), available);
  assert.throws(() => resolveAvailableModel("provider/registered-only", source), {
    code: "MODEL_SELECTION_ERROR",
  });
});

test("uses Pi-supported effort values and rejects arbitrary values", () => {
  const reasoning = model("provider", "reasoning", {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  });
  assert.deepEqual(supportedModelEfforts(reasoning), getSupportedThinkingLevels(reasoning));
  assert.throws(() => validateModelEffort(reasoning, "ultra"), { code: "MODEL_SELECTION_ERROR" });
  assert.equal(validateModelEffort(reasoning, "high"), "high");
});

test("model-only overrides clamp inherited effort through Pi", () => {
  const base = model("provider", "base", {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" },
  });
  const target = model("provider", "target", {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low" },
  });
  const resolved = resolveAgentModelOverride(
    { modelObject: base, model: "provider/base", effort: "high" },
    { model: "provider/target" },
    registry([base, target]),
  );
  assert.equal(resolved.model, "provider/target");
  assert.equal(resolved.effort, clampThinkingLevel(target, "high"));
});

test("session inheritance and configured model are snapshotted as a concrete pair", () => {
  const session = model("provider", "session", {
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  });
  const configured = model("provider", "configured", { reasoning: false });
  const source = registry([session, configured]);
  const inherited = resolveWorkflowModel({ sessionModel: session, sessionEffort: "high", registry: source });
  assert.equal(inherited.model, "provider/session");
  assert.equal(inherited.effort, "high");
  const fixed = resolveWorkflowModel({
    setting: { model: "provider/configured" },
    sessionModel: session,
    registry: source,
  });
  assert.equal(fixed.model, "provider/configured");
  assert.equal(fixed.effort, "off");
});
