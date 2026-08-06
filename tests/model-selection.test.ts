import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createWorkflowModelScopeSnapshot,
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

test("empty Pi scope means every currently available model is usable", () => {
  const first = model("provider-a", "first");
  const second = model("provider-b", "second");
  const source = registry([first, second], [first, second, model("provider-c", "registered-only")]);
  const snapshot = createWorkflowModelScopeSnapshot(source, []);

  assert.equal(snapshot.restricted, false);
  assert.deepEqual(snapshot.getAvailable(), [first, second]);
  assert.equal(snapshot.scopedThinkingLevel(first), undefined);
});

test("non-empty Pi scope intersects availability by canonical identity and preserves pinned effort", () => {
  const first = model("provider-a", "first");
  const second = model("provider-b", "second");
  const registeredOnly = model("provider-c", "registered-only");
  const source = registry([first, second], [first, second, registeredOnly]);
  const snapshot = createWorkflowModelScopeSnapshot(source, [
    { model: { ...first }, thinkingLevel: "high" },
    { model: registeredOnly, thinkingLevel: "low" },
  ]);

  assert.equal(snapshot.restricted, true);
  assert.deepEqual(snapshot.getAvailable(), [first]);
  assert.equal(snapshot.getAvailable()[0], first);
  assert.equal(snapshot.scopedThinkingLevel(first), "high");
  assert.equal(snapshot.scopedThinkingLevel(second), undefined);
});

test("an available-empty scope intersection stays restricted and never falls back to getAll", () => {
  const registeredOnly = model("provider", "registered-only");
  const source = {
    getAvailable: () => [] as readonly Model<Api>[],
    getAll: () => [registeredOnly],
  };
  const snapshot = createWorkflowModelScopeSnapshot(source, [{ model: registeredOnly }]);

  assert.equal(snapshot.restricted, true);
  assert.deepEqual(snapshot.getAvailable(), []);
});

test("missing or malformed Pi scope fails closed", () => {
  const available = model("provider", "available");
  const source = registry([available], [available]);

  for (const malformed of [undefined, {}, [{ model: undefined }], [{ model: available, thinkingLevel: "ultra" }]]) {
    const snapshot = createWorkflowModelScopeSnapshot(source, malformed);
    assert.equal(snapshot.restricted, true);
    assert.deepEqual(snapshot.getAvailable(), []);
  }
});

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

test("fixed Workflow Models use a Pi-scoped effort default before inherited effort", () => {
  const session = model("provider", "session", {
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  });
  const fixed = model("provider", "fixed", {
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  });
  const source = registry([session, fixed]);
  const scope = createWorkflowModelScopeSnapshot(source, [{ model: fixed, thinkingLevel: "high" }]);

  const scoped = resolveWorkflowModel({
    setting: { model: "provider/fixed" },
    sessionModel: session,
    sessionEffort: "low",
    registry: scope,
    modelScope: scope,
  });
  assert.equal(scoped.effort, "high");

  const explicit = resolveWorkflowModel({
    setting: { model: "provider/fixed", effort: "low" },
    sessionModel: session,
    sessionEffort: "high",
    registry: scope,
    modelScope: scope,
  });
  assert.equal(explicit.effort, "low");

  const inheritedScope = createWorkflowModelScopeSnapshot(source, [{ model: session }]);
  const inherited = resolveWorkflowModel({
    setting: null,
    sessionModel: session,
    sessionEffort: "low",
    registry: inheritedScope,
    modelScope: inheritedScope,
  });
  assert.equal(inherited.effort, "low");
});

test("model-only agent overrides use the target scope pin before clamping", () => {
  const base = model("provider", "base", {
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  });
  const target = model("provider", "target", {
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  });
  const source = registry([base, target]);
  const scope = createWorkflowModelScopeSnapshot(source, [{ model: target, thinkingLevel: "low" }]);
  const resolved = resolveAgentModelOverride(
    { modelObject: base, model: "provider/base", effort: "high" },
    { model: "provider/target" },
    scope,
    scope,
  );

  assert.equal(resolved.model, "provider/target");
  assert.equal(resolved.effort, "low");
});

test("unsupported Pi-scoped effort fails closed for new model selections", () => {
  const plain = model("provider", "plain");
  const source = registry([plain]);
  const scope = createWorkflowModelScopeSnapshot(source, [{ model: plain, thinkingLevel: "high" }]);

  assert.throws(
    () =>
      resolveWorkflowModel({
        setting: { model: "provider/plain" },
        registry: scope,
        modelScope: scope,
      }),
    { code: "MODEL_SELECTION_ERROR" },
  );
  assert.throws(
    () =>
      resolveAgentModelOverride(
        { modelObject: plain, model: "provider/plain", effort: "off" },
        { model: "provider/plain" },
        scope,
        scope,
      ),
    { code: "MODEL_SELECTION_ERROR" },
  );
});
