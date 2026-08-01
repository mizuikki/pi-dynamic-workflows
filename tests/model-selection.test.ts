import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  resolveAgentModelOverride,
  resolveRegisteredModel,
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

function registry(models: Model<Api>[]) {
  return { getAll: () => models };
}

test("resolves exact and unique bare registered model ids", () => {
  const first = model("provider-a", "shared");
  const second = model("provider-b", "other");
  const source = registry([first, second]);
  assert.equal(resolveRegisteredModel("provider-a/shared", source), first);
  assert.equal(resolveRegisteredModel("other", source), second);
  assert.throws(() => resolveRegisteredModel("shared", registry([first, model("provider-b", "shared")])), {
    code: "MODEL_SELECTION_ERROR",
  });
  assert.throws(() => resolveRegisteredModel("provider-a/missing", source), { code: "MODEL_SELECTION_ERROR" });
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
