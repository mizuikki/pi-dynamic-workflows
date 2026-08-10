import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { createExplicitFauxModels, createFauxRuntimeBundle } from "./helpers/faux-models.js";

async function waitForLifecycle(promise: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: {
          model: faux.model,
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

test("WorkflowAgent awaits child session_shutdown before the run settles", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-shutdown-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-shutdown-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "shutdown-fixture",
    models: [{ id: "shutdown-model", name: "Shutdown Model" }],
  });
  let shutdownCount = 0;
  let resourceLive = true;
  let enterShutdown = () => {};
  let releaseShutdown = () => {};
  const shutdownEntered = new Promise<void>((resolve) => {
    enterShutdown = resolve;
  });
  const shutdownReleased = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
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
            pi.on("session_shutdown", async (event) => {
              shutdownCount += 1;
              assert.equal(event.reason, "quit");
              enterShutdown();
              await shutdownReleased;
              resourceLive = false;
            });
          },
        ],
      });
      await resourceLoader.reload();
      faux.setResponses([fauxAssistantMessage("child completed")]);
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: {
          model: faux.model,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });

      const run = agent.run("Complete the child lifecycle test.", { label: "shutdown-check" });
      await waitForLifecycle(shutdownEntered, "child session_shutdown");
      let settled = false;
      void run.finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(settled, false, "run must await asynchronous child shutdown");
      assert.equal(resourceLive, true);

      releaseShutdown();
      assert.equal(await run, "child completed");
      assert.equal(resourceLive, false);
      assert.equal(shutdownCount, 1);
    });
  } finally {
    releaseShutdown();
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent preserves the child result when a shutdown handler rejects", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-shutdown-error-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-shutdown-error-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "shutdown-error-fixture",
    models: [{ id: "shutdown-error-model", name: "Shutdown Error Model" }],
  });
  const extensionErrors: string[] = [];
  const originalConsoleError = console.error;

  try {
    console.error = (...args: unknown[]) => {
      extensionErrors.push(args.map(String).join(" "));
    };
    await withFakeHomeAsync(home, async () => {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("session_shutdown", async () => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              throw new Error("expected shutdown fixture failure");
            });
          },
        ],
      });
      await resourceLoader.reload();
      faux.setResponses([fauxAssistantMessage("primary child result")]);
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: {
          model: faux.model,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });

      assert.equal(
        await agent.run("Preserve the primary result.", { label: "shutdown-error" }),
        "primary child result",
      );
      assert.equal(extensionErrors.length, 1);
      assert.match(extensionErrors[0] ?? "", /expected shutdown fixture failure/);
    });
  } finally {
    console.error = originalConsoleError;
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent shuts down child extensions on cancellation and provider failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-terminal-shutdown-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-terminal-shutdown-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "terminal-shutdown-fixture",
    models: [{ id: "terminal-shutdown-model", name: "Terminal Shutdown Model" }],
  });
  let shutdownCount = 0;

  try {
    await withFakeHomeAsync(home, async () => {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("session_shutdown", async (event) => {
              assert.equal(event.reason, "quit");
              await new Promise((resolve) => setTimeout(resolve, 0));
              shutdownCount += 1;
            });
          },
        ],
      });
      await resourceLoader.reload();
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const createAgent = () =>
        new WorkflowAgent({
          cwd,
          modelRegistry,
          modelRuntime,
          session: {
            model: faux.model,
            resourceLoader,
            sessionManager: SessionManager.inMemory(),
            settingsManager,
          },
        });

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => createAgent().run("Cancel before prompting.", { label: "cancelled-child", signal: controller.signal }),
        /Subagent was aborted/,
      );
      assert.equal(shutdownCount, 1);

      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "unexpected provider configuration" }),
      ]);
      await assert.rejects(
        () => createAgent().run("Return a provider failure.", { label: "failed-child" }),
        /unexpected provider configuration/,
      );
      assert.equal(shutdownCount, 2);
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent real child active tools exclude recursive orchestration tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-deny-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-deny-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "deny-fixture",
    models: [{ id: "deny-model", name: "Deny Model" }],
  });
  const activeTools: string[][] = [];
  try {
    await withFakeHomeAsync(home, async () => {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const tool = (name: string) => ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: name }], details: {} };
        },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi: ExtensionAPI) => pi.registerTool(tool("workflow")),
          (pi: ExtensionAPI) => {
            pi.registerTool(tool("custom_orchestrator"));
            pi.registerTool(tool("kept_tool"));
            pi.on("session_start", () => activeTools.push(pi.getActiveTools()));
          },
        ],
      });
      await resourceLoader.reload();
      faux.setResponses([fauxAssistantMessage("done")]);
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        excludeTools: ["custom_orchestrator"],
        session: {
          model: faux.model,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });

      assert.equal(await agent.run("inspect tools"), "done");
      assert.equal(activeTools.length, 1);
      assert.equal(activeTools[0]?.includes("workflow"), false);
      assert.equal(activeTools[0]?.includes("custom_orchestrator"), false);
      assert.equal(activeTools[0]?.includes("kept_tool"), true);
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent preserves adaptor-owned tools required by a restricted child profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-profile-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-profile-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const faux = createExplicitFauxModels({
    provider: "provider-fixture",
    models: [{ id: "profile-model", name: "Profile Model", contextWindow: 128000, maxTokens: 16384 }],
  });
  const profileToolReadiness: boolean[] = [];

  try {
    await withFakeHomeAsync(home, async () => {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi: ExtensionAPI) => {
            let profileToolVisible = false;
            pi.registerTool({
              name: "profile_tool",
              label: "Profile Tool",
              description: "Fixture profile-owned tool.",
              promptSnippet: "Call profile_tool.",
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: profileToolVisible ? "profile-ready" : "profile-missing" }],
                  details: {},
                  isError: !profileToolVisible,
                };
              },
            });
            pi.on("session_start", () => {
              profileToolVisible = pi.getAllTools().some((tool) => tool.name === "profile_tool");
              profileToolReadiness.push(profileToolVisible);
            });
          },
        ],
      });
      await resourceLoader.reload();
      const getExtensions = resourceLoader.getExtensions.bind(resourceLoader);
      resourceLoader.getExtensions = () => {
        const result = getExtensions();
        return {
          ...result,
          extensions: result.extensions.map((extension, index) =>
            index === 0
              ? {
                  ...extension,
                  path: "/extensions/pi-codex-adaptor/src/extension.ts",
                  resolvedPath: "/extensions/pi-codex-adaptor/src/extension.ts",
                }
              : extension,
          ),
        };
      };

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("profile_tool", {}), { type: "text", text: "profile tool completed" }], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("profile tool completed"),
      ]);
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: { model: faux.model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory() },
      });

      const result = await agent.run("Use the profile tool.", {
        label: "profile-tools",
        toolNames: ["bash"],
      });

      assert.equal(result, "profile tool completed");
      assert.deepEqual(profileToolReadiness, [true]);
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

      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: {
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

test("WorkflowAgent does not initialize persistence when a session manager is injected", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-injected-session-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-injected-session-cwd-"));
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "injected-session", name: "Injected Session Faux" }],
  });

  try {
    await withFakeHomeAsync(home, async () => {
      faux.setResponses([fauxAssistantMessage("injected session works")]);
      const agentDir = join(home, ".pi", "agent");
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        persistAgentSessions: true,
        session: {
          model: faux.model,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.create(cwd, agentDir),
        },
      });

      assert.equal(
        await agent.run("Use the injected session manager.", { label: "injected-session" }),
        "injected session works",
      );
      assert.equal(existsSync(join(agentDir, "sessions")), false);
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
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

test("wrapResourceLoader filters workflow path and tool/command identities", () => {
  const extension = (path: string, resolvedPath: string, toolNames: string[] = [], commandNames: string[] = []) =>
    ({
      path,
      resolvedPath,
      sourceInfo: {} as never,
      handlers: new Map(),
      tools: new Map(toolNames.map((name) => [name, {} as never])),
      messageRenderers: new Map(),
      commands: new Map(commandNames.map((name) => [name, {} as never])),
      flags: new Map(),
      shortcuts: new Map(),
    }) as Extension;
  const baseResult = {
    extensions: [
      extension("extensions/workflow.mjs", "/tmp/project/extensions/safe.ts"),
      extension("extensions/safe.ts", "C:\\PROJECT\\EXTENSIONS\\WORKFLOW.CJS"),
      extension("extensions/safe-filter.ts", "/tmp/project/other-filter.ts"),
      extension("<inline:workflow>", "<inline:workflow>", ["workflow"]),
      extension("<inline:prompt>", "<inline:prompt>", [], ["workflow"]),
      extension("extensions/other.ts", "/tmp/project/extensions/other.ts"),
    ],
    errors: [
      { path: "extensions/safe-error.ts", resolvedPath: "/tmp/project/extensions/workflow.js", error: "workflow" },
      { path: "extensions/other-error.ts", error: "other" },
    ],
    runtime: {} as never,
  } as LoadExtensionsResult;
  const baseLoader = {
    getExtensions: () => baseResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as ResourceLoader;
  const seen: string[] = [];

  const result = wrapResourceLoaderForWorkflowSubagents(baseLoader, {
    extensionPathFilters: [
      (pathValue) => {
        seen.push(pathValue);
        return pathValue.toLowerCase().includes("other");
      },
    ],
  }).getExtensions();

  assert.deepEqual(
    result.extensions.map((entry) => entry.path),
    [],
    "workflow variants and custom-filtered extensions should all be removed",
  );
  assert.deepEqual(
    result.errors.map((entry) => entry.path),
    [],
    "workflow variants and custom-filtered errors should all be removed",
  );
  assert.ok(seen.includes("extensions/safe-filter.ts"), "custom filters see the relative extension path");
  assert.ok(seen.includes("/tmp/project/other-filter.ts"), "custom filters see resolved paths too");
});
