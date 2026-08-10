import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCodingTools, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorkflowModelScopeSnapshot } from "../src/model-selection.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels, createFauxRuntimeBundle } from "./helpers/faux-models.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mgr-explicit-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const oneAgentScript = `export const meta = { name: 'explicit_registry', description: 'one agent' }
const a = await agent('report the workflow result', { label: 'a' })
return { a }`;

const selectedModelScript = `export const meta = { name: 'selected_model', description: 'selected model' }
const a = await agent('report the selected model', { label: 'a' })
return { a }`;

const resumeWithCustomToolsScript = `export const meta = { name: 'resume_with_custom_tools', description: 'resume with custom tools' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

test(
  "WorkflowManager passes the live session model runtime to real workflow subagents",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [{ id: "explicit-workflow", name: "Explicit Workflow Model" }],
    });
    try {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      faux.setResponses([fauxAssistantMessage("explicit workflow result")]);

      const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${faux.model.id}` });
      manager.setModelRegistry(modelRegistry);
      manager.setModelRuntime(modelRuntime);
      manager.setSessionOptions({ model: faux.model });

      const result = await manager.runSync(oneAgentScript);

      assert.equal((result.result as { a: string }).a, "explicit workflow result");
      assert.equal(faux.getPendingResponseCount(), 0, "the explicit model provider should be consumed");
    } finally {
      faux.dispose();
    }
  }),
);

test(
  "real faux-provider child execution uses the admitted scoped model",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [
        { id: "scope-allowed", name: "Scope Allowed Model" },
        { id: "scope-outside", name: "Scope Outside Model" },
      ],
    });
    try {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const allowed = faux.getModel("scope-allowed");
      if (!allowed) throw new Error("scope-allowed faux model should exist");
      faux.setResponses([(_context, _options, _state, model) => fauxAssistantMessage(`resolved:${model.id}`)]);
      saveWorkflowSettings({ workflowModel: { model: `${faux.provider}/${allowed.id}` } }, { cwd, scope: "project" });

      const manager = new WorkflowManager({
        cwd,
        modelRegistry,
        modelRuntime,
        modelScope: createWorkflowModelScopeSnapshot(modelRegistry, [{ model: allowed }]),
        session: { model: allowed },
      });
      const result = await manager.runSync(selectedModelScript);

      assert.equal((result.result as { a: string }).a, "resolved:scope-allowed");
      assert.equal(faux.getPendingResponseCount(), 0, "the scoped faux provider response should be consumed");
    } finally {
      faux.dispose();
    }
  }),
);

test(
  "real faux-provider admission rejects an out-of-scope model before child setup",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [
        { id: "scope-allowed", name: "Scope Allowed Model" },
        { id: "scope-outside", name: "Scope Outside Model" },
      ],
    });
    try {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const allowed = faux.getModel("scope-allowed");
      const outside = faux.getModel("scope-outside");
      if (!allowed || !outside) throw new Error("scope faux models should exist");
      saveWorkflowSettings({ workflowModel: { model: `${faux.provider}/${outside.id}` } }, { cwd, scope: "project" });

      const manager = new WorkflowManager({
        cwd,
        modelRegistry,
        modelRuntime,
        modelScope: createWorkflowModelScopeSnapshot(modelRegistry, [{ model: allowed }]),
        session: { model: allowed },
      });

      await assert.rejects(manager.runSync(selectedModelScript), { code: "MODEL_SELECTION_ERROR" });
      assert.deepEqual(manager.listRuns(), [], "out-of-scope admission must not publish a run");
      assert.equal(faux.getPendingResponseCount(), 0, "out-of-scope admission must not create a child session");
    } finally {
      faux.dispose();
    }
  }),
);

test(
  "WorkflowManager uses the active session model as the default for untagged subagents",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [
        { id: "workflow-default", name: "Workflow Default Model" },
        { id: "workflow-selected", name: "Workflow Selected Model" },
      ],
    });
    try {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const selectedModel = faux.getModel("workflow-selected");

      if (!selectedModel) {
        throw new Error("selected faux model should exist");
      }

      faux.setResponses([(_context, _options, _state, model) => fauxAssistantMessage(`resolved:${model.id}`)]);

      const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${selectedModel.id}` });
      manager.setModelRegistry(modelRegistry);
      manager.setModelRuntime(modelRuntime);
      manager.setSessionOptions({ model: selectedModel });

      const result = await manager.runSync(selectedModelScript);

      assert.equal((result.result as { a: string }).a, "resolved:workflow-selected");
      assert.equal(faux.getPendingResponseCount(), 0, "the selected session model should be consumed");
    } finally {
      faux.dispose();
    }
  }),
);

test(
  "WorkflowManager rejects a fixed unavailable model before starting a child",
  withTempCwd(async (cwd) => {
    let agentCalls = 0;
    const availableModel = { provider: "deepseek", id: "available", name: "Available", reasoning: false } as any;
    saveWorkflowSettings({ workflowModel: { model: "deepseek/registered-only" } }, { cwd, scope: "project" });

    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          agentCalls++;
          return "unexpected";
        },
      },
      modelRegistry: { getAvailable: () => [availableModel] } as any,
      session: { model: availableModel },
    });

    await assert.rejects(manager.runSync(oneAgentScript), { code: "MODEL_SELECTION_ERROR" });
    assert.equal(agentCalls, 0, "unavailable fixed settings must fail before child execution");
    assert.deepEqual(manager.listRuns(), [], "admission failure must not create a persisted run");
  }),
);

test(
  "WorkflowManager resume restores the original non-default tool surface",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [{ id: "workflow-custom", name: "Workflow Custom Model" }],
    });
    try {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const selectedModel = faux.getModel("workflow-custom");

      if (!selectedModel) {
        throw new Error("workflow custom model should exist");
      }

      let customToolCalls = 0;
      const preservedTool = defineTool({
        name: "preserved_context",
        label: "Preserved Context",
        description: "A custom tool retained across resume.",
        parameters: Type.Object({}),
        async execute() {
          customToolCalls += 1;
          return { content: [{ type: "text", text: "custom tool result" }], details: {} };
        },
      });

      faux.setResponses([
        fauxAssistantMessage("first-result"),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Codex usage limit reached. Resets in ~3h.",
        }),
      ]);

      const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${selectedModel.id}` });
      manager.setModelRegistry(modelRegistry);
      manager.setModelRuntime(modelRuntime);
      manager.setSessionOptions({ model: selectedModel });

      const { runId, promise } = manager.startInBackground(resumeWithCustomToolsScript, undefined, {
        tools: [...createCodingTools(cwd), preservedTool],
      });
      await promise.catch(() => {});

      assert.equal(manager.getRun(runId)?.status, "paused", "run should pause on provider usage limit");

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("preserved_context", {}), { type: "text", text: "Used preserved_context" }],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("second-result"),
      ]);

      assert.equal(await manager.resume(runId), true, "resumed run should restart with its original tools");
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(customToolCalls, 1, "the custom tool should execute after resume");
      assert.equal(manager.getRun(runId)?.status, "completed");
      assert.equal((manager.getRun(runId)?.result?.result as { a: string; b: string }).a, "first-result");
      assert.equal((manager.getRun(runId)?.result?.result as { a: string; b: string }).b, "second-result");
    } finally {
      faux.dispose();
    }
  }),
);
