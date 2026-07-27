import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.js";
import {
  disableWorkflowMainPrompt,
  enableWorkflowMainPrompt,
  getWorkflowMainPromptSettingsPath,
} from "../src/main-agent-prompt.js";
import { workflowDatabasePath } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("workflow extension refreshes live model guidance on model_select without re-enabling the tool", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-ext-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ext-cwd-"));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
  const registeredTools: ToolDefinition[] = [];
  let activeTools = ["read"];

  const explicitModel = {
    provider: "explicit-faux",
    id: "workflow-model",
    api: "faux",
    name: "Workflow Model",
    baseUrl: "http://localhost:0",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  } satisfies Model<"faux">;

  const pi = {
    extensionSdkApiVersion: 1,
    modelRuntimeApiVersion: 1,
    retryPolicySnapshotApiVersion: 1,
    registerTool: (tool: ToolDefinition) => {
      registeredTools.push(tool);
    },
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;

  try {
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(pi);
      } finally {
        process.chdir(originalCwd);
      }

      const modelSelect = handlers.get("model_select");
      assert.ok(modelSelect, "model_select handler should be registered");

      const ctx = {
        cwd,
        hasUI: false,
        mode: "print",
        ui: {},
        modelRegistry: {
          getAvailable: async () => [explicitModel],
        },
        model: explicitModel,
        sessionManager: {
          getSessionId: () => "session-123",
        },
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      } as unknown as ExtensionContext;

      await modelSelect?.({ type: "model_select" }, ctx);
    });

    const workflowTool = registeredTools.at(-1);
    assert.ok(workflowTool, "workflow tool should be registered");
    const guidelines = workflowTool.promptGuidelines?.join(" ") ?? "";
    assert.match(guidelines, /explicit-faux\/workflow-model/);
    assert.equal(
      activeTools.includes("workflow"),
      false,
      "model_select refresh should not re-enable the workflow tool",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow extension injects the live host prompt only for trusted host turns", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-home-"));
  const hostCwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-host-"));
  const runCwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-run-"));
  const promptPath = join(runCwd, ".pi", "WORKFLOW_MAIN.md");
  const originalChild = process.env.TRELLIS_SUBAGENT_CHILD;
  const originalDynamicChild = process.env.PI_DYNAMIC_WORKFLOWS_CHILD;
  const originalContextId = process.env.TRELLIS_CONTEXT_ID;
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(runCwd, ".pi"), { recursive: true });
    writeFileSync(promptPath, "host-only instructions");
    const harness = makeExtensionHarness({ cwd: runCwd });
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(hostCwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      const handler = harness.handlers.get("before_agent_start");
      assert.ok(handler, "before_agent_start handler should be registered");
      assert.equal(
        await handler({ type: "before_agent_start", systemPrompt: "base" }, harness.ctx),
        undefined,
        "missing opt-in must skip the prompt file",
      );
      enableWorkflowMainPrompt(runCwd);
      const baseEvent = { type: "before_agent_start", systemPrompt: "earlier prompt" };
      const injected = await handler(baseEvent, harness.ctx);
      assert.equal(
        (injected as { systemPrompt?: string } | undefined)?.systemPrompt,
        "earlier prompt\n\n<!-- pi-dynamic-workflows:workflow-main -->\nhost-only instructions",
      );

      disableWorkflowMainPrompt(runCwd);
      assert.equal(await handler(baseEvent, harness.ctx), undefined, "disable takes effect without a reload");
      enableWorkflowMainPrompt(runCwd);

      writeFileSync(promptPath, "rewritten instructions");
      const rewritten = await handler(baseEvent, harness.ctx);
      assert.match((rewritten as { systemPrompt?: string }).systemPrompt ?? "", /rewritten instructions/);

      harness.ctx.isProjectTrusted = () => false;
      assert.equal(await handler(baseEvent, harness.ctx), undefined, "untrusted projects fail closed");
      harness.ctx.isProjectTrusted = () => true;

      process.env.TRELLIS_CONTEXT_ID = "pi_session";
      assert.notEqual(await handler(baseEvent, harness.ctx), undefined, "context id alone is not child identity");
      process.env.TRELLIS_SUBAGENT_CHILD = "1";
      assert.equal(await handler(baseEvent, harness.ctx), undefined);
      delete process.env.TRELLIS_SUBAGENT_CHILD;
      process.env.PI_DYNAMIC_WORKFLOWS_CHILD = "1";
      assert.equal(await handler(baseEvent, harness.ctx), undefined);
    });
  } finally {
    if (originalChild === undefined) delete process.env.TRELLIS_SUBAGENT_CHILD;
    else process.env.TRELLIS_SUBAGENT_CHILD = originalChild;
    if (originalDynamicChild === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_CHILD;
    else process.env.PI_DYNAMIC_WORKFLOWS_CHILD = originalDynamicChild;
    if (originalContextId === undefined) delete process.env.TRELLIS_CONTEXT_ID;
    else process.env.TRELLIS_CONTEXT_ID = originalContextId;
    rmSync(home, { recursive: true, force: true });
    rmSync(hostCwd, { recursive: true, force: true });
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("explicit workflow-main-prompt flag injects for one run without persistence", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-flag-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-flag-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "WORKFLOW_MAIN.md"), "headless explicit prompt");
    const harness = makeExtensionHarness({ cwd });
    await withFakeHomeAsync(home, async () => {
      extension(harness.pi);
      const handler = harness.handlers.get("before_agent_start");
      assert.ok(handler);
      assert.equal(await handler({ type: "before_agent_start", systemPrompt: "base" }, harness.ctx), undefined);
      harness.setWorkflowMainPromptFlag(true);
      const result = await handler({ type: "before_agent_start", systemPrompt: "base" }, harness.ctx);
      assert.match((result as { systemPrompt?: string }).systemPrompt ?? "", /headless explicit prompt/);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

function makeExtensionHarness(options: { cwd: string; registeredTools?: ToolDefinition[]; activeTools?: string[] }) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
  const registeredTools = options.registeredTools ?? [];
  let activeTools = options.activeTools ?? ["read"];
  let workflowMainPromptFlag = false;
  const pi = {
    extensionSdkApiVersion: 1,
    modelRuntimeApiVersion: 1,
    retryPolicySnapshotApiVersion: 1,
    registerTool: (tool: ToolDefinition) => {
      registeredTools.push(tool);
    },
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
    getThinkingLevel: () => "medium",
    getFlag: (name: string) => (name === "workflow-main-prompt" ? workflowMainPromptFlag : undefined),
    getAllTools: () => registeredTools.map((tool) => ({ name: tool.name })),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: options.cwd,
    hasUI: false,
    mode: "print",
    ui: {
      setWidget: () => {},
      setStatus: () => {},
      setTitle: () => {},
      notify: () => {},
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
    },
    modelRegistry: {
      getAvailable: async () => [],
    },
    model: undefined,
    sessionManager: {
      getSessionId: () => "session-trellis",
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
  return {
    pi,
    handlers,
    registeredTools,
    getActiveTools: () => activeTools,
    setActiveTools: (value: string[]) => {
      activeTools = [...value];
    },
    setWorkflowMainPromptFlag: (value: boolean) => {
      workflowMainPromptFlag = value;
    },
    ctx,
  };
}

test("workflow extension rejects an incompatible host before registering tools", () => {
  let registrations = 0;
  const pi = {
    extensionSdkApiVersion: 1,
    modelRuntimeApiVersion: undefined,
    retryPolicySnapshotApiVersion: 1,
    registerTool: () => {
      registrations += 1;
    },
  } as unknown as ExtensionAPI;

  assert.throws(() => extension(pi), /requires model runtime API version 1/);
  assert.equal(registrations, 0);
});

test("workflow extension rejects an incompatible extension SDK before registering tools", () => {
  let registrations = 0;
  const pi = {
    extensionSdkApiVersion: undefined,
    modelRuntimeApiVersion: 1,
    retryPolicySnapshotApiVersion: 1,
    registerTool: () => {
      registrations += 1;
    },
  } as unknown as ExtensionAPI;

  assert.throws(() => extension(pi), /requires extension SDK API version 1/);
  assert.equal(registrations, 0);
});

test("workflow extension rejects a missing retry snapshot capability before registering tools", () => {
  let registrations = 0;
  const pi = {
    extensionSdkApiVersion: 1,
    modelRuntimeApiVersion: 1,
    retryPolicySnapshotApiVersion: undefined,
    registerTool: () => {
      registrations += 1;
    },
  } as unknown as ExtensionAPI;

  assert.throws(() => extension(pi), /requires retry policy snapshot API version 1/);
  assert.equal(registrations, 0);
});

test("workflow extension rejects the wrong retry snapshot capability before registering tools", () => {
  let registrations = 0;
  const pi = {
    extensionSdkApiVersion: 1,
    modelRuntimeApiVersion: 1,
    retryPolicySnapshotApiVersion: 2,
    registerTool: () => {
      registrations += 1;
    },
  } as unknown as ExtensionAPI;

  assert.throws(() => extension(pi), /requires retry policy snapshot API version 1/);
  assert.equal(registrations, 0);
});

test("workflow extension warns once and ignores stale defaultAgentRetries", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-stale-retry-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-stale-retry-cwd-"));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    await withFakeHomeAsync(home, async () => {
      const { mkdirSync } = await import("node:fs");
      const settingsDir = join(home, ".pi", "workflows");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ defaultAgentRetries: 3 }));
      console.warn = (message?: unknown) => warnings.push(String(message));
      const harness = makeExtensionHarness({ cwd });
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
    });
    assert.deepEqual(
      warnings.filter((message) => message.includes("defaultAgentRetries")),
      ["[workflow] defaultAgentRetries is deprecated and ignored; use explicit agentRunRetries per run"],
    );
  } finally {
    console.warn = originalWarn;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session_start initializes SQLite after binding and session_shutdown is idempotent", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-lifecycle-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-lifecycle-cwd-"));
  try {
    const harness = makeExtensionHarness({ cwd });
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      const start = harness.handlers.get("session_start");
      const shutdown = harness.handlers.get("session_shutdown");
      assert.ok(start);
      assert.ok(shutdown);
      await start?.({ type: "session_start" }, harness.ctx);
      assert.equal(existsSync(workflowDatabasePath()), true);
      await shutdown?.({ type: "session_shutdown" }, harness.ctx);
      await shutdown?.({ type: "session_shutdown" }, harness.ctx);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registers trellis_subagent on model_select when native extension is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-ext-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-ext-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.1\n", "utf-8");
    const harness = makeExtensionHarness({ cwd });
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      const modelSelect = harness.handlers.get("model_select");
      assert.ok(modelSelect, "model_select handler should be registered");
      await modelSelect?.({ type: "model_select" }, harness.ctx);
    });
    const names = harness.registeredTools.map((tool) => tool.name);
    assert.ok(names.includes("workflow"), `expected workflow tool; got ${names.join(",")}`);
    assert.ok(names.includes("trellis_subagent"), `expected trellis_subagent; got ${names.join(",")}`);
    assert.ok(harness.getActiveTools().includes("trellis_subagent"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("disables the Trellis adapter for an unsupported project version", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-version-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-version-cwd-"));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "0.6.7\n", "utf-8");
    const harness = makeExtensionHarness({ cwd });
    console.warn = (message: unknown) => warnings.push(String(message));
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      await harness.handlers.get("model_select")?.({ type: "model_select" }, harness.ctx);
    });
    assert.ok(warnings.includes("[trellis-adapter] disabled: requires Trellis project version 1.0.1"));
    assert.equal(
      harness.registeredTools.some((tool) => tool.name === "trellis_subagent"),
      false,
    );
  } finally {
    console.warn = originalWarn;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("trellis_subagent remains inactive after explicit deactivation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-inactive-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-inactive-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.1\n", "utf-8");
    const harness = makeExtensionHarness({ cwd });
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      const modelSelect = harness.handlers.get("model_select");
      const input = harness.handlers.get("input");
      assert.ok(modelSelect);
      assert.ok(input);
      await modelSelect?.({ type: "model_select" }, harness.ctx);
      assert.ok(harness.getActiveTools().includes("trellis_subagent"));
      harness.setActiveTools(["read"]);
      await input?.({ type: "input" }, harness.ctx);
      assert.equal(harness.getActiveTools().includes("trellis_subagent"), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("skips trellis_subagent registration when tool already registered", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-dup-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-dup-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.1\n", "utf-8");
    const harness = makeExtensionHarness({
      cwd,
      registeredTools: [{ name: "trellis_subagent" } as ToolDefinition],
      activeTools: ["read", "trellis_subagent"],
    });
    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        extension(harness.pi);
      } finally {
        process.chdir(originalCwd);
      }
      const modelSelect = harness.handlers.get("model_select");
      assert.ok(modelSelect);
      await modelSelect?.({ type: "model_select" }, harness.ctx);
    });
    const trellisRegs = harness.registeredTools.filter((tool) => tool.name === "trellis_subagent");
    assert.equal(trellisRegs.length, 1, "must not double-register trellis_subagent");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
