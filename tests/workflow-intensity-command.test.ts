import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntensityState,
  handleWorkflowIntensityCommand,
  intensityDirective,
  isSubstantive,
} from "../src/intensity-command.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";

test("intensityDirective returns an orchestration-intensity nudge for high/ultra, nothing for off", () => {
  assert.equal(intensityDirective("off"), undefined);
  const high = intensityDirective("high") ?? "";
  const ultra = intensityDirective("ultra") ?? "";
  assert.match(high, /HIGH/);
  assert.match(ultra, /ULTRA/);
  assert.match(high, /structured output is disabled/i);
  assert.match(ultra, /structured output is disabled/i);
});

test("intensityDirective adapts quality guidance to the structured-output capability", () => {
  const disabled = intensityDirective("ultra", false) ?? "";
  assert.match(disabled, /text-safe reviewers/i);
  assert.match(disabled, /structured output is disabled/i);
  assert.doesNotMatch(disabled, /prefer verify\(\)/i);

  const enabled = intensityDirective("ultra", true) ?? "";
  assert.match(enabled, /reviewers\/judges/i);
  assert.match(enabled, /completenessCheck/i);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflow"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildForcedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildForcedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildForcedWorkflowPrompt("do X", intensityDirective("ultra"));
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

function harness(state: ReturnType<typeof createIntensityState>) {
  const sent: string[] = [];
  const pi = {
    sendMessage: (message: { content: string }) => sent.push(message.content),
  };
  const run = (args: string) => handleWorkflowIntensityCommand(pi as never, state, args, {} as never);
  return { run, sent };
}

test("/workflow intensity toggles the shared state", async () => {
  const state = createIntensityState();
  const { run, sent } = harness(state);
  assert.equal(state.level, "off");

  await run("ultra");
  assert.equal(state.level, "ultra");
  await run("high");
  assert.equal(state.level, "high");
  await run("off");
  assert.equal(state.level, "off");
  await run("bogus");
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
  assert.match(sent.at(-1) ?? "", /Usage: \/workflow intensity/);
});
