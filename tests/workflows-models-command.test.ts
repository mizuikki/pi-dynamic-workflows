import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
import { editWorkflowModel, registerWorkflowModelsCommand } from "../src/workflows-models-command.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function model(provider: string, id: string, reasoning = false) {
  return {
    provider,
    id,
    name: id,
    reasoning,
    ...(reasoning
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        }
      : {}),
  } as any;
}

function context(select: (...args: any[]) => Promise<string | undefined>, models = [model("provider", "plain")]) {
  return {
    cwd: "/tmp/workflow-model-command",
    model: models[0],
    modelRegistry: { getAll: () => models },
    ui: { select: mock.fn(select), notify: mock.fn() },
  } as any;
}

test("registerWorkflowModelsCommand registers a single Workflow Model command", () => {
  let description = "";
  const pi = {
    registerCommand: (_name: string, options: { description?: string }) => {
      description = options.description ?? "";
    },
  };
  registerWorkflowModelsCommand(pi as never);
  assert.match(description, /Workflow Model/);
  assert.doesNotMatch(description, /small|medium|big|tier/i);
});

test("editWorkflowModel reports an empty Pi registry", async () => {
  const ctx = context(async () => undefined, []);
  const result = await editWorkflowModel(ctx, null);
  assert.equal(result, undefined);
  assert.equal(ctx.ui.notify.mock.callCount(), 1);
  assert.match(String(ctx.ui.notify.mock.calls[0]?.arguments[0]), /No registered Pi models/);
});

test("editWorkflowModel returns a model with inherited effort", async () => {
  const ctx = context(async (_title: string, choices: string[]) => choices[0] as string, [model("provider", "plain")]);
  const result = await editWorkflowModel(ctx, undefined);
  assert.deepEqual(result, { model: "provider/plain" });
  assert.equal(ctx.ui.select.mock.callCount(), 2);
});

test("editWorkflowModel offers only Pi-supported dynamic efforts", async () => {
  let effortChoices: string[] = [];
  const reasoning = model("provider", "reasoning", true);
  const ctx = context(
    async (_title: string, choices: string[]) => {
      if (choices[0] === "provider/reasoning") return "provider/reasoning";
      effortChoices = choices;
      return "xhigh";
    },
    [reasoning],
  );
  const result = await editWorkflowModel(ctx, undefined);
  assert.deepEqual(result, { model: "provider/reasoning", effort: "xhigh" });
  assert.ok(effortChoices.includes("xhigh"));
  assert.ok(effortChoices.includes("max"));
  assert.ok(!effortChoices.includes("ultra"));
});

test("editWorkflowModel can be cancelled before persistence", async () => {
  const ctx = context(async () => undefined);
  assert.equal(await editWorkflowModel(ctx, undefined), undefined);
});

test("openWorkflowModelEditor labels unset project settings separately from effective inheritance", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-workflow-model-command-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-workflow-model-command-cwd-"));
  const titles: string[] = [];
  const choicesSeen: string[] = [];
  try {
    await withFakeHomeAsync(home, async () => {
      saveWorkflowSettings({ workflowModel: { model: "provider/global", effort: "high" } });
      const ctx = {
        ...context(async (title: string, choices: string[]) => {
          titles.push(title);
          choicesSeen.push(...choices);
          return "Exit";
        }),
        cwd,
      };
      const { openWorkflowModelEditor } = await import("../src/workflows-models-command.js");
      await openWorkflowModelEditor(ctx as never);
    });
    assert.match(titles[0] ?? "", /effective: provider\/global @ high/);
    assert.ok(choicesSeen.includes("Edit project Workflow Model (unset)"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
