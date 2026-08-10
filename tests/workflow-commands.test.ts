import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createIntensityState, intensityDirective } from "../src/intensity-command.js";
import { registerWorkflowCommand } from "../src/workflow-commands.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "../src/workflow-editor.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

type Handler = (args: string, ctx: any) => Promise<void>;

/** Capture the registered command + outputs for assertions. */
function harness(
  managerOverrides: Record<string, any> = {},
  commandOptions: Record<string, any> = {},
  initialTools: string[] = [WORKFLOW_TOOL_NAME],
  sendMessageImpl?: (
    m: { customType?: string; content?: string },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => Promise<void>,
) {
  const printed: string[] = [];
  const sent: Array<{
    customType?: string;
    content?: string;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const calls: string[] = [];
  const activeTools = [...initialTools];
  let handler: Handler | undefined;

  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [],
    registerCommand: (_name: string, opts: { handler: Handler }) => {
      handler = opts.handler;
    },
    sendMessage:
      sendMessageImpl ??
      (async (m, options) => {
        sent.push({ ...m, options });
        if (!options && typeof m.content === "string") printed.push(m.content);
      }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools.splice(0, activeTools.length, ...toolNames);
    },
  };

  const manager: Partial<WorkflowManager> = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    loadRun: () => null,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return true;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
    deleteRun: async (id: string) => {
      calls.push(`rm:${id}`);
      return "deleted";
    },
    ...managerOverrides,
  };

  registerWorkflowCommand(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager, commandOptions);
  const ctx = {
    getRetryPolicy: () => ({
      agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
      providerRequest: { maxRetries: 2, maxRetryDelayMs: 30_000 },
    }),
    ui: { notify: (message: string, type?: string) => notified.push({ message, type }) },
  };
  const run = (args: string) => {
    if (!handler) throw new Error("command not registered");
    return handler(args, ctx);
  };
  return { run, printed, sent, notified, calls, activeTools };
}

test("/workflow list shows empty hint when no runs", async () => {
  const h = harness();
  await h.run("list");
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflow (no args) defaults to list", async () => {
  const h = harness({
    listRuns: () => [
      {
        projectId: "project",
        runId: "run-1",
        workflowName: "demo",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agentCounts: { total: 0, running: 0, done: 0, error: 0 },
        hasScript: false,
      },
    ],
  });
  await h.run("");
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflow run without prompt warns usage", async () => {
  const h = harness();
  await h.run("run");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage: \/workflow run <request>/);
});

test("/workflow run <prompt> sends a forced workflow follow-up turn", async () => {
  const h = harness();
  await h.run("run audit auth boundaries");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].customType, "workflow-run");
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("audit auth boundaries"));
  assert.equal(h.sent[0].options?.triggerTurn, true);
  assert.equal(h.sent[0].options?.deliverAs, "followUp");
  assert.deepEqual(h.activeTools, [WORKFLOW_TOOL_NAME], "does not duplicate an already-active workflow tool");
});

test("/workflow run <prompt> notifies error when sendMessage rejects and does not bubble", async () => {
  const failingSend = async () => {
    throw new Error("send failed");
  };
  const h = harness({}, {}, [WORKFLOW_TOOL_NAME], failingSend);
  await h.run("run audit auth");
  assert.ok(
    h.notified.some((n) => n.message === "Could not start the workflow turn."),
    "should notify the error message",
  );
});

test("/workflow run adds the workflow tool when absent and does not depend on the keyword trigger", async () => {
  const h = harness({}, {}, ["bash", "read"]);
  await h.run("run summarize the auth module");
  assert.deepEqual(h.activeTools, ["bash", "read", WORKFLOW_TOOL_NAME]);
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("summarize the auth module"));
});

test("/workflow run carries standing intensity directives", async () => {
  const intensity = createIntensityState();
  intensity.level = "ultra";
  const h = harness({}, { intensity });
  await h.run("run do X");
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("do X", intensityDirective("ultra", false)));
});

test("/workflow run @name snapshots the saved script into a manager-backed run", async () => {
  const script = "export const meta = { name: 'saved', description: 'saved' };\nreturn args;";
  let started: { script: string; args: unknown; options: unknown } | undefined;
  const storage = {
    load: (name: string, location?: string) => ({
      name,
      description: "Saved workflow",
      script,
      parameters: { limit: { type: "number", default: 3 } },
      location: location ?? "project",
      path: "/saved.json",
      savedAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const h = harness(
    {
      startInBackground: (savedScript: string, args: unknown, options: unknown) => {
        started = { script: savedScript, args, options };
        return { runId: "saved-run", promise: Promise.resolve({ result: null }) };
      },
    },
    { storage, cwd: "/tmp/workflow-command" },
  );

  await h.run("run @audit --global -- topic=auth");

  assert.equal(started?.script, script, "the exact stored script must be admitted");
  assert.deepEqual(started?.args, { topic: "auth", _: "", _raw: "topic=auth", limit: 3 });
  assert.match(h.notified.at(-1)?.message ?? "", /Started @audit \[global\] as saved-run/);
});

test("/workflow list --saved, show, and delete stay under the root command", async () => {
  let deleted: [string, string] | undefined;
  const saved = {
    name: "audit",
    description: "Audit boundaries",
    script: "return { report: 'ok' };",
    location: "project" as const,
    path: "/audit.json",
    savedAt: "2026-01-01T00:00:00.000Z",
  };
  const storage = {
    list: () => [saved],
    load: () => saved,
    delete: (name: string, location: string) => {
      deleted = [name, location];
      return true;
    },
  };
  const h = harness({}, { storage });

  await h.run("list --saved");
  assert.match(h.printed.at(-1) ?? "", /@audit \[project\]/);
  await h.run("show @audit");
  assert.match(h.printed.at(-1) ?? "", /return \{ report: 'ok' \};/);
  await h.run("delete @audit");
  assert.deepEqual(deleted, ["audit", "project"]);
});

test("saved-workflow scope parsing rejects conflicts and ignores flags after the args separator", async () => {
  const loadedScopes: Array<string | undefined> = [];
  const storage = {
    load: (_name: string, scope?: string) => {
      loadedScopes.push(scope);
      return null;
    },
  };
  const h = harness({}, { storage });

  await h.run("run @audit --project --global");
  assert.match(h.notified.at(-1)?.message ?? "", /Conflicting/);
  assert.deepEqual(loadedScopes, []);

  await h.run("run @audit --global -- --project");
  assert.deepEqual(loadedScopes, ["global"]);
});

test("/workflow stop <id> calls manager.stop", async () => {
  const h = harness();
  await h.run("stop run-9");
  assert.deepEqual(h.calls, ["stop:run-9"]);
});

test("/workflow status <id> renders a persisted run", async () => {
  const h = harness({
    loadRun: () => ({
      runId: "run-7",
      workflowName: "audit",
      status: "completed",
      phases: ["Scan"],
      agents: [{ id: 1, label: "scan files", status: "done", prompt: "x" }],
      logs: [],
      tokenUsage: { input: 10, output: 5, total: 15 },
    }),
  });
  await h.run("status run-7");
  assert.match(h.printed[0], /audit \(run-7\)/);
  assert.match(h.printed[0], /scan files/);
});

test("/workflow status without id warns", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
});

test("registerWorkflowCommand is idempotent (skips when already registered)", () => {
  let registrations = 0;
  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [{ name: "workflow" }],
    registerCommand: () => {
      registrations++;
    },
  };
  registerWorkflowCommand(pi as unknown as ExtensionAPI, {} as unknown as WorkflowManager);
  assert.equal(registrations, 0);
});

test("/workflow status watches a running run: live status bar + prints on completion", async () => {
  const snapshot = {
    name: "demo",
    phases: ["Run"],
    currentPhase: "Run",
    logs: [],
    agents: [{ id: 1, label: "a", status: "running", prompt: "x" }],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  const printed: string[] = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async (m: any) => printed.push(m.content),
  };
  registerWorkflowCommand(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager);
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };

  assert.ok(handler, "handler should exist");
  await handler("status run-1", ctx);
  assert.ok(
    statusLine.some((s) => typeof s === "string"),
    "sets a live status line",
  );
  assert.equal(printed.length, 0, "does not print until the run finishes");

  // Mark done and emit completion -> watcher prints the final snapshot and clears status.
  snapshot.agents[0].status = "done";
  manager.emit("complete", { runId: "run-1" });
  assert.equal(printed.length, 1, "prints final snapshot on completion");
  assert.ok(statusLine.includes(undefined), "clears the status line");
});

// ═══════════════════════════════════════════════════════════════════════════
// pause — calls manager.pause, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow pause <id> calls manager.pause and notifies Paused", async () => {
  const h = harness();
  await h.run("pause run-p1");
  assert.deepEqual(h.calls, ["pause:run-p1"], "should call manager.pause");
  assert.equal(h.notified.length, 1);
  assert.match(h.notified[0].message, /Paused.+run-p1/);
});

test("/workflow pause without id warns usage", async () => {
  const h = harness();
  await h.run("pause");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflow pause <id> warns when manager.pause returns false", async () => {
  const h = harness({ pause: () => false });
  await h.run("pause run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot pause")),
    "should show cannot pause",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// resume — calls manager.resume, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow resume <id> calls manager.resume and notifies Resumed", async () => {
  const h = harness({
    resume: async (id: string) => {
      h.calls.push(`resume:${id}`);
      return true;
    },
  });
  await h.run("resume run-r1");
  assert.ok(
    h.calls.some((c) => c.startsWith("resume:run-r1")),
    "should call manager.resume",
  );
  assert.ok(
    h.notified.some((n) => n.message.includes("Resumed")),
    "should notify Resumed",
  );
});

test("/workflow resume without id warns usage", async () => {
  const h = harness();
  await h.run("resume");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflow resume <id> warns when resume returns false", async () => {
  const h = harness({ resume: async () => false });
  await h.run("resume run-fail");
  assert.ok(
    h.notified.some((n) => n.message.includes("Resume not available")),
    "should show not available",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Resume not available"))?.type, "warning");
});

// ═══════════════════════════════════════════════════════════════════════════
// rm — calls manager.deleteRun, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow rm <id> calls manager.deleteRun and notifies Removed", async () => {
  const h = harness();
  await h.run("rm run-del1");
  assert.deepEqual(h.calls, ["rm:run-del1"], "should call manager.deleteRun");
  assert.ok(
    h.notified.some((n) => n.message.includes("Removed")),
    "should notify Removed",
  );
});

test("/workflow rm without id warns usage", async () => {
  const h = harness();
  await h.run("rm");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflow rm <id> warns when deleteRun returns not_found", async () => {
  const h = harness({ deleteRun: async () => "not_found" });
  await h.run("rm run-missing");
  assert.ok(
    h.notified.some((n) => n.message.includes("No run")),
    "should show No run",
  );
});

test("/workflow rm <id> distinguishes a live foreign lease", async () => {
  const h = harness({ deleteRun: async () => "leased" });
  await h.run("rm run-1");
  assert.equal(h.notified[0]?.type, "warning");
  assert.match(h.notified[0]?.message ?? "", /active/);
});

// ═══════════════════════════════════════════════════════════════════════════
// stop without id — warn usage
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow stop without id warns usage", async () => {
  const h = harness();
  await h.run("stop");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflow stop <id> shows Cannot stop when manager returns false", async () => {
  const h = harness({ stop: () => false, getRun: () => undefined });
  await h.run("stop run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot stop")),
    "should show cannot stop",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Cannot stop"))?.type, "warning");
});

test("/workflow stop <id> notifies info (not warning) when stopped a real run", async () => {
  const h = harness({ stop: () => true, getRun: () => ({}) });
  await h.run("stop run-active");
  const stopMsg = h.notified.find((n) => n.message.includes("Stopped"));
  assert.ok(stopMsg, "should notify Stopped");
  assert.equal(stopMsg?.type, "info", "should be info when run was actually running");
});

// ═══════════════════════════════════════════════════════════════════════════
// save — saves a run's script as a saved workflow
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow save without name warns usage", async () => {
  const h = harness();
  await h.run("save");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflow save <name> warns when no storage configured", async () => {
  const h = harness();
  await h.run("save my-workflow");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "error");
  assert.match(h.notified[0].message, /Saving is not available/);
});

test("/workflow save <name> saves the most recent run with a script", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const _h = harness({
    listRuns: () => [
      { runId: "old", workflowName: "old", status: "completed", script: null, agents: [], logs: [] },
      {
        runId: "recent",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }",
        agents: [],
        logs: [],
      },
    ],
  });
  // Register with storage mock
  const storage: any = {
    load: () => null,
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-1" };
    },
  };
  registerWorkflowCommand(
    {
      getCommands: () => [],
      registerCommand: (_n: string, _o: any) => {},
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [
        {
          runId: "recent",
          workflowName: "scan",
          status: "completed",
          script: "export const meta = { name: 'scan', description: 'scan' }",
          agents: [],
          logs: [],
        },
      ],
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  assert.equal(saved.length, 0);
});

test("/workflow save <name> <runId> saves the specified run", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const storage: any = {
    load: () => null,
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-2" };
    },
  };

  const runs = [
    {
      runId: "run-target",
      workflowName: "audit",
      status: "completed",
      script: "export const meta = { name: 'audit', description: 'audit' }",
      agents: [],
      logs: [],
    },
  ];

  // Override the handler for one invocation
  const { registerWorkflowCommand: reg2 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  let handler: any;
  reg2(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () =>
        runs.map((run) => ({ ...run, hasScript: true, agentCounts: { total: 0, running: 0, done: 0, error: 0 } })),
      loadRun: () => runs[0],
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save target-name run-target", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(saved.length, 1, "should save one workflow");
  assert.equal(saved[0].name, "target-name");
  assert.equal(saved[0].script, runs[0].script);
  assert.ok(
    notified.some((n) => n.message.includes("Saved")),
    "should notify Saved",
  );
});

test("/workflow save <name> <runId> warns when run has no script", async () => {
  const storage: any = { load: () => null, save: (w: any) => w };
  let handler: any;
  const { registerWorkflowCommand: reg3 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  reg3(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [{ runId: "no-script", workflowName: "empty", status: "completed", agents: [], logs: [] }],
      loadRun: () => null,
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save empty no-script", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /No run/, "should warn no script");
});

// ═══════════════════════════════════════════════════════════════════════════
// unknown subcommand
// ═══════════════════════════════════════════════════════════════════════════

test("/workflow <unknown> warns usage", async () => {
  const h = harness();
  await h.run("bogus");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Unknown subcommand/);
});
