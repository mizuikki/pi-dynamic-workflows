import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-session-scope-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const oneAgentScript = `export const meta = { name: 'session_scope', description: 'session scope' }
const a = await agent('report session ownership', { label: 'a' })
return { a }`;

function seedRun(cwd: string, state: PersistedRunState) {
  const repository = createRunPersistence(cwd);
  const lease = repository.acquireRunLease(state.runId, "new");
  assert.ok(lease);
  repository.save(state, lease);
  repository.releaseRunLease(lease);
  repository.close();
}

test(
  "WorkflowManager persists the run under its original session id even if the manager session changes later",
  withTempCwd(async (cwd) => {
    let releaseAgentRun: (() => void) | undefined;
    const agent = {
      async run() {
        await new Promise<void>((resolve) => {
          releaseAgentRun = resolve;
        });
        return "done";
      },
    };

    const manager = new WorkflowManager({ cwd, agent });
    manager.setSessionId("session-a");

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    manager.setSessionId("session-b");
    releaseAgentRun?.();
    await promise;

    manager.setSessionId("session-a");
    const persisted = manager.loadRun(runId);
    assert.equal(persisted?.sessionId, "session-a");
  }),
);

test(
  "WorkflowManager refuses lifecycle access to runs from another session",
  withTempCwd(async (cwd) => {
    let releaseAgentRun: (() => void) | undefined;
    const agent = {
      async run() {
        await new Promise<void>((resolve) => {
          releaseAgentRun = resolve;
        });
        return "done";
      },
    };

    const manager = new WorkflowManager({ cwd, agent });
    manager.setSessionId("session-a");

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    manager.setSessionId("session-b");

    assert.equal(manager.getRun(runId), undefined);
    assert.equal(await manager.deleteRun(runId), "not_found");
    assert.equal(manager.stop(runId), false);

    manager.setSessionId("session-a");
    releaseAgentRun?.();
    await promise;
  }),
);

test(
  "WorkflowManager refuses to resume a persisted run owned by another session",
  withTempCwd(async (cwd) => {
    const runId = "persisted-session-a";
    seedRun(cwd, {
      runId,
      workflowName: "session_owned",
      script: oneAgentScript,
      sessionId: "session-a",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const other = new WorkflowManager({ cwd, sessionId: "session-b" });
    assert.equal(await other.resume(runId), false);
    assert.equal(other.loadRun(runId), null, "the foreign session payload must not be selected");
  }),
);

test(
  "installResultDelivery suppresses background delivery after switching to another session",
  withTempCwd(async (cwd) => {
    let releaseAgentRun: (() => void) | undefined;
    const sentInSessionA: string[] = [];
    const sentInSessionB: string[] = [];
    const agent = {
      async run() {
        await new Promise<void>((resolve) => {
          releaseAgentRun = resolve;
        });
        return "done";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.setSessionId("session-a");

    const piSessionA = {
      sendMessage: async (message: { content?: string }) => {
        if (message.content) {
          sentInSessionA.push(message.content);
        }
      },
    } as unknown as ExtensionAPI;
    installResultDelivery(piSessionA, manager);

    const { promise } = manager.startInBackground(oneAgentScript);

    manager.setSessionId("session-b");
    const piSessionB = {
      sendMessage: async (message: { content?: string }) => {
        if (message.content) {
          sentInSessionB.push(message.content);
        }
      },
    } as unknown as ExtensionAPI;
    installResultDelivery(piSessionB, manager);

    releaseAgentRun?.();
    await promise;

    assert.deepEqual(sentInSessionA, []);
    assert.deepEqual(sentInSessionB, []);
  }),
);
