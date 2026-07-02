import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createCodingTools } from "../src/pi-coding-agent-sdk.js";
import { createWebTools } from "../src/web-tools.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels } from "./helpers/faux-models.js";

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

const resumeWithWebToolsScript = `export const meta = { name: 'resume_with_web_tools', description: 'resume with web tools' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

test(
  "WorkflowManager passes the live session model registry to real workflow subagents",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [{ id: "explicit-workflow", name: "Explicit Workflow Model" }],
    });
    const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory(), faux.models);
    faux.setResponses([fauxAssistantMessage("explicit workflow result")]);

    const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${faux.model.id}` });
    manager.setSessionOptions({ modelRegistry, model: faux.model, models: faux.models });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: string }).a, "explicit workflow result");
    assert.equal(faux.getPendingResponseCount(), 0, "the explicit model provider should be consumed");
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
    const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory(), faux.models);
    const selectedModel = faux.getModel("workflow-selected");

    if (!selectedModel) {
      throw new Error("selected faux model should exist");
    }

    faux.setResponses([(_context, _options, _state, model) => fauxAssistantMessage(`resolved:${model.id}`)]);

    const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${selectedModel.id}` });
    manager.setSessionOptions({ modelRegistry, model: selectedModel, models: faux.models });

    const result = await manager.runSync(selectedModelScript);

    assert.equal((result.result as { a: string }).a, "resolved:workflow-selected");
    assert.equal(faux.getPendingResponseCount(), 0, "the selected session model should be consumed");
  }),
);

test(
  "WorkflowManager resume restores the original non-default tool surface",
  withTempCwd(async (cwd) => {
    const faux = createExplicitFauxModels({
      provider: "deepseek",
      models: [{ id: "workflow-web", name: "Workflow Web Model" }],
    });
    const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory(), faux.models);
    const selectedModel = faux.getModel("workflow-web");

    if (!selectedModel) {
      throw new Error("workflow web model should exist");
    }

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        '<html><body><h2><a href="https://example.com/result">Result</a></h2><p>Example body</p></body></html>',
        { status: 200 },
      );
    };

    try {
      faux.setResponses([
        fauxAssistantMessage("first-result"),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Codex usage limit reached. Resets in ~3h.",
        }),
      ]);

      const manager = new WorkflowManager({ cwd, mainModel: `${faux.provider}/${selectedModel.id}` });
      manager.setSessionOptions({ modelRegistry, model: selectedModel, models: faux.models });

      const { runId, promise } = manager.startInBackground(resumeWithWebToolsScript, undefined, {
        tools: [...createCodingTools(cwd), ...createWebTools()],
      });
      await promise.catch(() => {});

      assert.equal(manager.getRun(runId)?.status, "paused", "run should pause on provider usage limit");

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("web_search", { query: "pi workflow" }), { type: "text", text: "Used web_search" }],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("second-result"),
      ]);

      assert.equal(await manager.resume(runId), true, "resumed run should restart with its original tools");
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(fetchCalls, 1, "web_search should execute after resume");
      assert.equal(manager.getRun(runId)?.status, "completed");
      assert.equal((manager.getRun(runId)?.result?.result as { a: string; b: string }).a, "first-result");
      assert.equal((manager.getRun(runId)?.result?.result as { a: string; b: string }).b, "second-result");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);
