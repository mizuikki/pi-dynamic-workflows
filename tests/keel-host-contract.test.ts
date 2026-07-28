import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createKeelPiHostDescriptor,
  type JournalEntry,
  KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION,
  KEEL_PI_INVOCATION_SCHEMA_VERSION,
  type KeelHostBridgeV1,
  type KeelLoadedInvocationV1,
  type KeelPiLifecycleObservation,
  runWorkflow,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
} from "../src/index.js";

const SCRIPT = `export const meta = { name: 'keel_contract', description: 'contract test' }
return await agent('do work', { label: 'worker', agentType: 'keel-implement' })`;

function contextTool(name = "keel_context_read") {
  return {
    name,
    label: "Context Read",
    description: "Read immutable context",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "context value" }], details: {} };
    },
  } as never;
}

function loadedInvocation(snapshot = "snapshot-1"): KeelLoadedInvocationV1 {
  return {
    invocation: {
      schemaVersion: KEEL_PI_INVOCATION_SCHEMA_VERSION,
      workflowInstanceId: "workflow-1",
      stepRunId: "step-1",
      agentRunId: "agent-1",
      logicalInvocationId: "logical-1",
      contextSnapshotId: snapshot,
      idempotencyKey: "outcome:logical-1",
      role: "keel-implement",
      allowedContextTools: ["context.read"],
    },
    observationIds: { started: "observation-started-1", terminal: "observation-terminal-1" },
    context: {
      promptPrefix: "keel context",
      instructions: "use immutable context",
      env: { KEEL_CONTEXT_SNAPSHOT_ID: snapshot, SHARED: "keel" },
    },
    contextTools: [{ capability: "context.read", tool: contextTool() }],
  };
}

function recordingBridge(options: { snapshot?: () => string; loaded?: () => unknown } = {}) {
  const observations: KeelPiLifecycleObservation[] = [];
  const loads: Array<{ workflowRunId: string; callIndex: number }> = [];
  const bridge: KeelHostBridgeV1 = {
    schemaVersion: KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION,
    descriptor: createKeelPiHostDescriptor({
      revision: "6b29c9e1a2f09fee6e041fb5e239ae664f06c005",
      packageVersion: "2.14.0",
      distribution: "maintained-fork-checkout",
    }),
    async loadInvocation(input) {
      loads.push(input.source);
      return (options.loaded?.() ?? loadedInvocation(options.snapshot?.() ?? "snapshot-1")) as KeelLoadedInvocationV1;
    },
    observe(observation) {
      observations.push(observation);
    },
  };
  return { bridge, observations, loads };
}

test("descriptor factory advertises the versioned Keel capabilities with caller provenance", () => {
  const descriptor = createKeelPiHostDescriptor({
    revision: "6b29c9e1a2f09fee6e041fb5e239ae664f06c005",
    distribution: "maintained-fork-checkout",
  });
  assert.equal(descriptor.schemaVersion, "keel.pi-host-descriptor/v1");
  assert.equal(descriptor.abi.id, "pi-dynamic-workflows-host");
  assert.deepEqual(
    descriptor.capabilities.map((capability) => capability.id),
    ["context-snapshot-identity", "logical-invocation-identity", "controlled-context-tools", "lifecycle-observation"],
  );
});

test("configured malformed bridge fails before child execution", async () => {
  let calls = 0;
  const { bridge } = recordingBridge();
  const malformed = {
    ...bridge,
    descriptor: { ...bridge.descriptor, capabilities: bridge.descriptor.capabilities.slice(1) },
  };
  await assert.rejects(
    () =>
      runWorkflow(SCRIPT, {
        keelHost: malformed as KeelHostBridgeV1,
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
        persistLogs: false,
      }),
    (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR,
  );
  assert.equal(calls, 0);
});

test("malformed invocation identity fails before child execution", async () => {
  let calls = 0;
  const { bridge } = recordingBridge({
    loaded: () => ({
      ...loadedInvocation(),
      invocation: { ...loadedInvocation().invocation, contextSnapshotId: "" },
    }),
  });
  await assert.rejects(
    () =>
      runWorkflow(SCRIPT, {
        keelHost: bridge,
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
        persistLogs: false,
      }),
    (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR,
  );
  assert.equal(calls, 0);
});

test("live invocation merges context, injects only bound tools, and emits one logical lifecycle", async () => {
  const { bridge, observations, loads } = recordingBridge();
  let toolResult: unknown;
  const result = await runWorkflow(SCRIPT, {
    runId: "pi-run-1",
    keelHost: bridge,
    contextLoader: async () => ({
      promptPrefix: "generic context",
      instructions: "generic instructions",
      env: { GENERIC: "yes", SHARED: "generic" },
    }),
    agent: {
      async run(prompt: string, options: any) {
        assert.equal(prompt, "generic context\n\nkeel context\n\ndo work");
        assert.equal(options.instructions.includes("generic instructions"), true);
        assert.equal(options.instructions.includes("use immutable context"), true);
        assert.deepEqual(options.env, {
          GENERIC: "yes",
          SHARED: "keel",
          KEEL_CONTEXT_SNAPSHOT_ID: "snapshot-1",
        });
        assert.equal(options.keelInvocation.contextSnapshotId, "snapshot-1");
        assert.deepEqual(
          options.systemTools.map((tool: { name: string }) => tool.name),
          ["store_put", "store_get", "keel_context_read"],
        );
        toolResult = await options.systemTools[2].execute("call-1", {});
        return "done";
      },
    },
    persistLogs: false,
  });

  assert.equal(result.result, "done");
  assert.deepEqual(loads, [{ workflowRunId: "pi-run-1", callIndex: 0 }]);
  assert.equal((toolResult as { content: Array<{ text: string }> }).content[0]?.text, "context value");
  assert.deepEqual(
    observations.map((observation) => [observation.kind, observation.delivery, observation.observationId]),
    [
      ["started", "live", "observation-started-1"],
      ["terminal", "live", "observation-terminal-1"],
    ],
  );
  const terminal = observations[1];
  assert.equal(terminal?.kind === "terminal" ? terminal.outcome.status : undefined, "succeeded");
});

test("disallowed and colliding Keel context tools fail before child execution", async () => {
  for (const loaded of [
    () => ({
      ...loadedInvocation(),
      contextTools: [{ capability: "context.list", tool: contextTool() }],
    }),
    () => ({
      ...loadedInvocation(),
      contextTools: [{ capability: "context.read", tool: contextTool("store_get") }],
    }),
  ]) {
    let calls = 0;
    const { bridge } = recordingBridge({ loaded });
    await assert.rejects(
      () =>
        runWorkflow(SCRIPT, {
          keelHost: bridge,
          agent: {
            async run() {
              calls++;
              return "unexpected";
            },
          },
          persistLogs: false,
        }),
      (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR,
    );
    assert.equal(calls, 0);
  }
});

test("cached replay redelivers stable identities and a changed snapshot invalidates the cache", async () => {
  let snapshot = "snapshot-1";
  const journal: JournalEntry[] = [];
  const first = recordingBridge({ snapshot: () => snapshot });
  let calls = 0;
  await runWorkflow(SCRIPT, {
    runId: "pi-run-resume",
    keelHost: first.bridge,
    agent: {
      async run() {
        calls++;
        return "done";
      },
    },
    onAgentJournal: (entry) => journal.push(entry),
    persistLogs: false,
  });

  const replay = recordingBridge({ snapshot: () => snapshot });
  await runWorkflow(SCRIPT, {
    runId: "pi-run-resume",
    keelHost: replay.bridge,
    agent: {
      async run() {
        calls++;
        return "unexpected";
      },
    },
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    persistLogs: false,
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    replay.observations.map((observation) => observation.delivery),
    ["cached_replay", "cached_replay"],
  );
  assert.deepEqual(
    replay.observations.map((observation) => observation.observationId),
    ["observation-started-1", "observation-terminal-1"],
  );

  snapshot = "snapshot-2";
  const changed = recordingBridge({ snapshot: () => snapshot });
  await runWorkflow(SCRIPT, {
    runId: "pi-run-resume",
    keelHost: changed.bridge,
    agent: {
      async run() {
        calls++;
        return "changed";
      },
    },
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    persistLogs: false,
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    changed.observations.map((observation) => observation.delivery),
    ["live", "live"],
  );
});

test("whole-agent retry emits one lifecycle envelope and one terminal failure", async () => {
  const successful = recordingBridge();
  let attempts = 0;
  await runWorkflow(SCRIPT, {
    keelHost: successful.bridge,
    agentRunRetries: 1,
    agent: {
      async run() {
        attempts++;
        return attempts === 1 ? "" : "done";
      },
    },
    persistLogs: false,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(
    successful.observations.map((observation) => observation.kind),
    ["started", "terminal"],
  );

  const failed = recordingBridge();
  await runWorkflow(SCRIPT, {
    keelHost: failed.bridge,
    agentRunRetries: 1,
    agent: {
      async run() {
        return "";
      },
    },
    persistLogs: false,
  });
  assert.deepEqual(
    failed.observations.map((observation) => observation.kind),
    ["started", "terminal"],
  );
  const terminal = failed.observations[1];
  assert.deepEqual(terminal?.kind === "terminal" ? terminal.outcome : undefined, {
    status: "failed",
    code: "AGENT_EMPTY_OUTPUT",
    message: "Subagent produced no assistant output",
    recoverable: true,
  });
});

test("non-recoverable child failure emits one structured terminal failure before propagating", async () => {
  const { bridge, observations } = recordingBridge();
  await assert.rejects(
    () =>
      runWorkflow(SCRIPT, {
        keelHost: bridge,
        agent: {
          async run() {
            throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
              recoverable: false,
            });
          },
        },
        persistLogs: false,
      }),
    (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );
  assert.deepEqual(
    observations.map((observation) => observation.kind),
    ["started", "terminal"],
  );
  const terminal = observations[1];
  assert.deepEqual(terminal?.kind === "terminal" ? terminal.outcome : undefined, {
    status: "failed",
    code: "SCHEMA_NONCOMPLIANCE",
    message: "schema failed",
    recoverable: false,
  });
});

test("abort emits one cancelled terminal observation and preserves workflow abort", async () => {
  const controller = new AbortController();
  const { bridge, observations } = recordingBridge();
  await assert.rejects(
    () =>
      runWorkflow(SCRIPT, {
        keelHost: bridge,
        signal: controller.signal,
        agent: {
          async run() {
            controller.abort();
            throw new Error("Subagent was aborted");
          },
        },
        persistLogs: false,
      }),
    /abort/i,
  );
  assert.deepEqual(
    observations.map((observation) => observation.kind),
    ["started", "terminal"],
  );
  const terminal = observations[1];
  assert.equal(terminal?.kind === "terminal" ? terminal.outcome.status : undefined, "cancelled");
});

test("nested workflows expose distinct run-scoped source references", async () => {
  const sources: Array<{ workflowRunId: string; callIndex: number }> = [];
  const observations: KeelPiLifecycleObservation[] = [];
  const descriptor = createKeelPiHostDescriptor({
    revision: "6b29c9e1a2f09fee6e041fb5e239ae664f06c005",
    distribution: "maintained-fork-checkout",
  });
  const bridge: KeelHostBridgeV1 = {
    schemaVersion: KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION,
    descriptor,
    async loadInvocation(input) {
      sources.push(input.source);
      const identity = `${input.source.workflowRunId}:${input.source.callIndex}`;
      return {
        ...loadedInvocation(),
        invocation: {
          ...loadedInvocation().invocation,
          agentRunId: `agent:${identity}`,
          logicalInvocationId: `logical:${identity}`,
          idempotencyKey: `outcome:${identity}`,
        },
        observationIds: { started: `started:${identity}`, terminal: `terminal:${identity}` },
      };
    },
    observe(observation) {
      observations.push(observation);
    },
  };
  const child = `export const meta = { name: 'child', description: 'child' }
return await agent('child work', { label: 'child' })`;
  const parent = `export const meta = { name: 'parent', description: 'parent' }
await agent('parent work', { label: 'parent' })
return await workflow('child')`;
  await runWorkflow(parent, {
    runId: "parent-run",
    keelHost: bridge,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
    agent: {
      async run() {
        return "done";
      },
    },
    persistLogs: false,
  });
  assert.deepEqual(sources, [
    { workflowRunId: "parent-run", callIndex: 0 },
    { workflowRunId: "parent-run-nested1", callIndex: 0 },
  ]);
  assert.equal(new Set(observations.map((observation) => observation.logicalInvocationId)).size, 2);
});

test("a new manager reattaches the bridge and redelivers a journaled result on cold resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-keel-resume-"));
  let runnerCalls = 0;
  let rejectTerminal = true;
  const recorded = recordingBridge();
  const bridge: KeelHostBridgeV1 = {
    ...recorded.bridge,
    async observe(observation) {
      recorded.observations.push(observation);
      if (rejectTerminal && observation.kind === "terminal") throw new Error("recorder unavailable");
    },
  };
  const first = new WorkflowManager({
    cwd,
    keelHost: bridge,
    agent: {
      async run() {
        runnerCalls++;
        return "done";
      },
    },
  });
  try {
    await assert.rejects(
      () => first.runSync(SCRIPT),
      (error) => error instanceof WorkflowError && error.code === WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR,
    );
    const runId = first.listRuns()[0]?.runId;
    assert.ok(runId);
    await first.dispose();

    rejectTerminal = false;
    recorded.observations.length = 0;
    const second = new WorkflowManager({
      cwd,
      keelHost: bridge,
      agent: {
        async run() {
          runnerCalls++;
          return "unexpected";
        },
      },
    });
    try {
      assert.equal(await second.resume(runId), true);
      await second.getRun(runId)?.executionPromise;
      assert.equal(second.getRun(runId)?.status, "completed");
      assert.equal(runnerCalls, 1);
      assert.deepEqual(
        recorded.observations.map((observation) => observation.delivery),
        ["cached_replay", "cached_replay"],
      );
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("omitting the bridge preserves the legacy workflow path", async () => {
  let calls = 0;
  const result = await runWorkflow(SCRIPT, {
    agent: {
      async run() {
        calls++;
        return "legacy";
      },
    },
    persistLogs: false,
  });
  assert.equal(result.result, "legacy");
  assert.equal(calls, 1);
});
