import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.js";
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

function makeExtensionHarness(options: { cwd: string; registeredTools?: ToolDefinition[]; activeTools?: string[] }) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
  const registeredTools = options.registeredTools ?? [];
  let activeTools = options.activeTools ?? ["read"];
  const pi = {
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
  return { pi, handlers, registeredTools, getActiveTools: () => activeTools, ctx };
}

test("registers trellis_subagent on model_select when native extension is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-ext-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-ext-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
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

test("skips trellis_subagent registration when tool already registered", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-trellis-dup-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-trellis-dup-cwd-"));
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
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
