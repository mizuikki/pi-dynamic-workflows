import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  type Extension,
  type ExtensionAPI,
  type LoadExtensionsResult,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowAgent, wrapResourceLoaderForWorkflowSubagents } from "../src/agent.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels } from "./helpers/faux-models.js";

test("WorkflowAgent binds extensions so session_start-initialized tools work in subagents", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-ext-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ext-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "workflow-ext", name: "Workflow Extension Faux", contextWindow: 128000, maxTokens: 16384 }],
  });

  try {
    await withFakeHomeAsync(home, async () => {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi: ExtensionAPI) => {
            let initialized = false;

            pi.on("session_start", () => {
              initialized = true;
              const active = pi.getActiveTools();
              if (!active.includes("session_ready_tool")) {
                pi.setActiveTools([...active, "session_ready_tool"]);
              }
            });

            pi.registerTool({
              name: "session_ready_tool",
              label: "Session Ready Tool",
              description: "Returns ok only after session_start initialized extension state.",
              promptSnippet: "Call session_ready_tool when checking extension lifecycle readiness.",
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: initialized ? "session-ready" : "not-initialized" }],
                  details: { initialized },
                  isError: !initialized,
                };
              },
            });
          },
        ],
      });
      await resourceLoader.reload();

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("session_ready_tool", {}), { type: "text", text: "tool returned session-ready" }],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("tool returned session-ready"),
      ]);

      const agent = new WorkflowAgent({
        cwd,
        session: {
          model: faux.model,
          models: faux.models,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });

      const result = await agent.run("Check whether extension lifecycle initialized the tool.", {
        label: "lifecycle-check",
      });

      assert.equal(result, "tool returned session-ready");
      assert.equal(faux.getPendingResponseCount(), 0, "all faux responses should be consumed");
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent uses the per-run cwd when loading default project settings under explicit Models", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-run-cwd-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-run-cwd-base-"));
  const runCwd = mkdtempSync(join(tmpdir(), "pi-dw-run-cwd-isolated-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [
      { id: "base-model", name: "Base Model" },
      { id: "run-model", name: "Run Model" },
    ],
  });

  try {
    await withFakeHomeAsync(home, async () => {
      SettingsManager.create(cwd, agentDir).setDefaultModelAndProvider(faux.provider, "base-model");
      SettingsManager.create(runCwd, agentDir).setDefaultModelAndProvider(faux.provider, "run-model");

      faux.setResponses([
        (_context, _options, _state, model) =>
          fauxAssistantMessage(`resolved:${model.provider}/${model.id}`, { stopReason: "stop" }),
      ]);

      const agent = new WorkflowAgent({
        cwd,
        session: {
          models: faux.models,
          sessionManager: SessionManager.inMemory(),
        },
      });

      const result = await agent.run("Report the selected model.", { cwd: runCwd, label: "run-cwd-check" });

      assert.equal(result, "resolved:deepseek/run-model");
      assert.equal(faux.getPendingResponseCount(), 0, "per-run settings should select the run cwd model");
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("wrapResourceLoaderForWorkflowSubagents drops the local workflow extension", () => {
  const workflowExtension = {
    path: "extensions/workflow.ts",
    resolvedPath: "/tmp/project/extensions/workflow.ts",
    sourceInfo: {} as never,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
  const safeExtension = {
    path: "extensions/safe.ts",
    resolvedPath: "/tmp/project/extensions/safe.ts",
    sourceInfo: {} as never,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
  const baseResult = {
    extensions: [workflowExtension, safeExtension],
    errors: [
      { path: "/tmp/project/extensions/workflow.ts", error: "workflow error" },
      { path: "/tmp/project/extensions/safe.ts", error: "safe error" },
    ],
    runtime: {} as never,
  } as LoadExtensionsResult;
  const baseLoader: ResourceLoader = {
    getExtensions: () => baseResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const filteredLoader = wrapResourceLoaderForWorkflowSubagents(baseLoader);
  const result = filteredLoader.getExtensions();

  assert.deepEqual(
    result.extensions.map((extension) => extension.path),
    ["extensions/safe.ts"],
    "workflow extension should be filtered out",
  );
  assert.deepEqual(
    result.errors.map((error) => error.path),
    ["/tmp/project/extensions/safe.ts"],
    "workflow extension errors should be filtered out",
  );
});
