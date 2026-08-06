import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";
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

function context(
  select: (...args: any[]) => Promise<string | undefined>,
  available = [model("provider", "plain")],
  registered = available,
  scopedModels: unknown[] = [],
) {
  return {
    cwd: "/tmp/workflow-model-command",
    model: available[0],
    modelRegistry: {
      getAvailable: () => available,
      getAll: () => registered,
      refresh: mock.fn(async () => undefined),
    },
    scopedModels,
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

test("editWorkflowModel reports an empty Pi availability snapshot", async () => {
  const ctx = context(async () => undefined, []);
  const result = await editWorkflowModel(ctx, null);
  assert.equal(result, undefined);
  assert.equal(ctx.ui.notify.mock.callCount(), 1);
  assert.match(String(ctx.ui.notify.mock.calls[0]?.arguments[0]), /No Pi models are currently available/);
});

test("editWorkflowModel exposes available models, not the larger built-in catalog", async () => {
  const available = model("provider", "available");
  const registeredOnly = model("provider", "registered-only");
  let modelChoices: string[] = [];
  const ctx = context(
    async (_title: string, choices: string[]) => {
      if (choices.some((choice) => choice === "provider/available")) {
        modelChoices = choices;
        return "provider/available";
      }
      return "Inherit current Pi session effort";
    },
    [available],
    [available, registeredOnly],
  );

  assert.deepEqual(await editWorkflowModel(ctx, undefined), { model: "provider/available" });
  assert.deepEqual(modelChoices, ["provider/available"]);
  assert.equal(ctx.modelRegistry.refresh.mock.callCount(), 1);
});

test("editWorkflowModel filters choices through the active non-empty Pi scope", async () => {
  const allowed = model("provider", "allowed");
  const outside = model("provider", "outside");
  let modelChoices: string[] = [];
  const ctx = context(
    async (_title: string, choices: string[]) => {
      if (choices.includes("provider/allowed")) {
        modelChoices = choices;
        return "provider/allowed";
      }
      return choices[0];
    },
    [allowed, outside],
    [allowed, outside],
    [{ model: allowed }],
  );

  assert.deepEqual(await editWorkflowModel(ctx, undefined), { model: "provider/allowed" });
  assert.deepEqual(modelChoices, ["provider/allowed"]);
});

test("editWorkflowModel fails closed when scoped entries are unavailable", async () => {
  const available = model("provider", "available");
  const unavailable = model("provider", "unavailable");
  const ctx = context(async () => undefined, [available], [available, unavailable], [{ model: unavailable }]);

  assert.equal(await editWorkflowModel(ctx, undefined), undefined);
  assert.match(String(ctx.ui.notify.mock.calls[0]?.arguments[0]), /No Pi models are currently available/);
});

test("editWorkflowModel treats an empty scope as all current available models", async () => {
  const first = model("provider", "first");
  const second = model("provider", "second");
  let modelChoices: string[] = [];
  const ctx = context(
    async (_title: string, choices: string[]) => {
      modelChoices = choices;
      return undefined;
    },
    [first, second],
    [first, second],
    [],
  );

  assert.equal(await editWorkflowModel(ctx, undefined), undefined);
  assert.deepEqual(modelChoices, ["provider/first", "provider/second"]);
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

test("openWorkflowModelEditor does not mutate settings when the picker is cancelled", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-workflow-model-cancel-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-workflow-model-cancel-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      saveWorkflowSettings({ workflowModel: { model: "provider/original" } });
      const before = loadWorkflowSettings().workflowModel;
      let calls = 0;
      const ctx = {
        ...context(async (_title: string, choices: string[]) => {
          calls++;
          if (calls === 1) return choices.find((choice) => choice.startsWith("Edit global"));
          return undefined;
        }),
        cwd,
      };
      const { openWorkflowModelEditor } = await import("../src/workflows-models-command.js");
      await openWorkflowModelEditor(ctx as never);
      assert.deepEqual(loadWorkflowSettings().workflowModel, before);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
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
