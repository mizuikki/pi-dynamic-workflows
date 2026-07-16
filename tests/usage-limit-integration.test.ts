/**
 * Real-session integration test for issue #26 — provider usage-limit handling.
 *
 * Every other test injects a fake agent runner; this one drives the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and uses the pi SDK's built-in
 * FAUX provider to end a turn in a "usage limit reached" error (stopReason
 * "error" + errorMessage), exactly as a real provider buries a quota exhaustion.
 * It is the contract guard for the load-bearing SDK assumption behind the fix:
 * a usage limit surfaces as an error-status assistant message, not a thrown error.
 * No network call is made and NO provider quota is consumed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels, createFauxModelRegistry } from "./helpers/faux-models.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

/**
 * Run `fn` with an isolated HOME and an explicitly injected faux registry. The
 * shared helper binds the provider through both standard Pi's dynamic registry
 * and the fork's explicit Models API, avoiding package-layout-dependent globals.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    modelRegistry: ReturnType<typeof createFauxModelRegistry>;
    setResponses: (msgs: unknown[]) => void;
    fauxAssistantMessage: typeof fauxAssistantMessage;
  }) => Promise<void>,
): Promise<void> {
  let home: string | undefined;
  let cwd: string | undefined;
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
    const testHome = home;
    const testCwd = cwd;
    if (!testHome || !testCwd) throw new Error("faux session setup failed");
    const modelRegistry = createFauxModelRegistry(faux);
    await withFakeHomeAsync(testHome, () =>
      fn({
        cwd: testCwd,
        model: faux.model,
        modelRegistry,
        setResponses: (msgs) => faux.setResponses(msgs as never),
        fauxAssistantMessage,
      }),
    );
  } finally {
    faux.dispose();
    if (home) rmSync(home, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, modelRegistry, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        const e = err as { code?: string; recoverable?: boolean; message?: string; resetHint?: string };
        assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `got ${e.code}`);
        assert.equal(e.recoverable, false, "must halt so the run can checkpoint, not retry-into-the-wall");
        assert.ok(e.message?.includes("usage limit reached"), "carries the real provider message");
        assert.equal(e.resetHint, "Resets in ~3h", "extracts the provider reset hint");
        return true;
      },
    );
  }));

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, modelRegistry, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, model, modelRegistry, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
    const manager = new WorkflowManager({ cwd, agent: managerAgent });
    const pausedReasons: Array<string | undefined> = [];
    manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'i26_integration', description: 'two agents' }
const a = await agent('first step', { label: 'first' })
const b = await agent('second step', { label: 'second' })
return { a, b }`;

    // Agent 1 succeeds (journaled); agent 2 hits the usage limit.
    setResponses([
      fauxAssistantMessage("first-result-text", { stopReason: "stop" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
    ]);
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {});

    assert.equal(manager.getRun(runId)?.status, "paused", "run is checkpointed as paused, not failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result is journaled");
    assert.ok(pausedReasons.includes("usage_limit"), "a usage_limit 'paused' event fired");

    // Budget refills: agent 2 now succeeds. Resume replays agent 1 from the journal.
    setResponses([fauxAssistantMessage("second-result-text", { stopReason: "stop" })]);
    assert.equal(await manager.resume(runId), true, "the paused run is resumable");
    await new Promise((r) => setTimeout(r, 100));

    const done = manager.getRun(runId);
    assert.equal(done?.status, "completed", "resumed run completes once the limit clears");
    assert.equal((done?.result?.result as { a?: string })?.a, "first-result-text", "agent 1 replayed from journal");
    assert.equal((done?.result?.result as { b?: string })?.b, "second-result-text", "agent 2 ran live after refill");
  }));
