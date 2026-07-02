import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

    const persisted = manager.listAllRuns().find((run) => run.runId === runId);
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

    const { runId } = manager.startInBackground(oneAgentScript);
    manager.setSessionId("session-b");

    assert.equal(manager.getRun(runId), undefined);
    assert.equal(manager.deleteRun(runId), false);
    assert.equal(manager.stop(runId), false);

    manager.setSessionId("session-a");
    releaseAgentRun?.();
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
