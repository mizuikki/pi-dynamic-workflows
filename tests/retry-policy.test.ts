import assert from "node:assert/strict";
import test from "node:test";
import {
  childRetrySettings,
  normalizeAgentRunRetries,
  normalizeAgentTurnRetryOverride,
  normalizeExecutionPolicy,
  normalizeHostRetryPolicySnapshot,
  readRequiredHostRetryPolicy,
  resolveAgentRunRetries,
} from "../src/retry-policy.js";

const host = {
  agentTurn: { enabled: true, maxRetries: 5, baseDelayMs: 2000 },
  providerRequest: { timeoutMs: 9000, maxRetries: 2, maxRetryDelayMs: 60000 },
};

test("normalizes and deeply freezes a fresh host retry snapshot", () => {
  const normalized = normalizeHostRetryPolicySnapshot(host);
  assert.deepEqual(normalized, host);
  assert.notEqual(normalized, host);
  assert.notEqual(normalized.agentTurn, host.agentTurn);
  assert.notEqual(normalized.providerRequest, host.providerRequest);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.agentTurn), true);
  assert.equal(Object.isFrozen(normalized.providerRequest), true);
});

test("reads the host getter exactly once and rejects a missing getter", () => {
  let calls = 0;
  const result = readRequiredHostRetryPolicy({
    getRetryPolicy: () => {
      calls++;
      return host;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.agentTurn.maxRetries, 5);
  assert.throws(() => readRequiredHostRetryPolicy({}), /getter is unavailable/);
});

test("merges agent-turn fields while replacing the provider object from the host", () => {
  const normalized = normalizeHostRetryPolicySnapshot(host);
  assert.deepEqual(childRetrySettings(normalized, { enabled: false, maxRetries: 3 }, { baseDelayMs: 25 }), {
    enabled: false,
    maxRetries: 3,
    baseDelayMs: 25,
    provider: { timeoutMs: 9000, maxRetries: 2, maxRetryDelayMs: 60000 },
  });
  const withoutOptionals = normalizeHostRetryPolicySnapshot({
    agentTurn: host.agentTurn,
    providerRequest: { maxRetryDelayMs: 60000 },
  });
  assert.deepEqual(childRetrySettings(withoutOptionals).provider, {
    timeoutMs: undefined,
    maxRetries: undefined,
    maxRetryDelayMs: 60000,
  });
});

test("uses semantic Clean Slate validation for canonical and alias retry counts", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeAgentRunRetries(value), /must/);
    assert.throws(() => resolveAgentRunRetries(undefined, value, { aliasName: "retries" }), /must/);
  }
  assert.equal(normalizeAgentRunRetries(0), 0);
  assert.equal(normalizeAgentRunRetries(3), 3);
  assert.equal(resolveAgentRunRetries(undefined, 2, { aliasName: "agentRetries" }), 2);
  assert.throws(
    () => resolveAgentRunRetries(1, 1, { aliasName: "agentRetries" }),
    /conflicts with deprecated agentRetries/,
  );
});

test("validates partial agent-turn overrides without coercion", () => {
  assert.deepEqual(normalizeAgentTurnRetryOverride({ enabled: false, maxRetries: 7, baseDelayMs: 0 }), {
    enabled: false,
    maxRetries: 7,
    baseDelayMs: 0,
  });
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeAgentTurnRetryOverride({ maxRetries: value }), /safe integer/);
    assert.throws(() => normalizeAgentTurnRetryOverride({ baseDelayMs: value }), /safe integer/);
  }
});

test("normalizes only explicit execution policy fields", () => {
  assert.deepEqual(normalizeExecutionPolicy({}), {});
  assert.deepEqual(normalizeExecutionPolicy({ agentRetries: 2, agentTurnRetry: { enabled: false } }), {
    agentRunRetries: 2,
    agentTurnRetry: { enabled: false },
  });
});
