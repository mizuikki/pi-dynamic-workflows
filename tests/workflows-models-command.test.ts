/**
 * Tests for workflows-models-command.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

async function loadCommand() {
  return await import("../src/workflows-models-command.js");
}

describe("workflows-models-command", () => {
  describe("registerWorkflowModelsCommand", () => {
    it("registers the workflows-models command with Pi", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const commands: string[] = [];
      const mockPi = {
        registerCommand: mock.fn((name: string) => {
          commands.push(name);
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);

      assert.equal(mockPi.registerCommand.mock.callCount(), 1);
      assert.equal(commands[0], "workflows-models");
    });

    it("provides a description", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let capturedDescription = "";

      const mockPi = {
        registerCommand: mock.fn((_name: string, opts: { description?: string }) => {
          capturedDescription = opts.description ?? "";
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(capturedDescription.length > 0, "description should not be empty");
      assert.ok(capturedDescription.toLowerCase().includes("thinking"), "description should mention thinking");
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user immediately backs out", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = {
        ui: {
          select: mock.fn(async () => "Back"),
          notify: mock.fn(),
        },
      };

      const result = await editSingleTier(ctx as never, { model: "openai/gpt-4.1-mini" }, "small");
      assert.equal(result, null);
    });

    it("updates the tier model via the model picker", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const selections = ["Model → openai/gpt-4.1-mini", "Back"];
      const getAvailable = mock.fn(async () => []);
      const ctx = {
        modelRegistry: {
          find: mock.fn((_provider: string, _id: string) => ({ provider: "openai", id: "gpt-5" })),
          getAvailable,
          getAvailableSync: mock.fn(() => []),
          getAll: mock.fn(() => []),
        },
        ui: {
          select: mock.fn(async () => selections.shift()),
          custom: mock.fn(async () => "openai/gpt-5"),
          notify: mock.fn(),
        },
      };

      const result = await editSingleTier(ctx as never, { model: "openai/gpt-4.1-mini" }, "small");
      assert.deepEqual(result, { model: "openai/gpt-5" });
      assert.equal(getAvailable.mock.callCount(), 1, "model picker should use the async available-model list");
    });

    it("can switch a tier to inherit current session thinking", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const selections = ["Thinking level → high", "inherit current session", "Back"];
      const ctx = {
        modelRegistry: {
          find: mock.fn((_provider: string, id: string) => ({
            provider: "openai",
            id,
            reasoning: true,
          })),
          getAvailable: mock.fn(async () => []),
          getAvailableSync: mock.fn(() => []),
          getAll: mock.fn(() => []),
        },
        ui: {
          select: mock.fn(async () => selections.shift()),
          notify: mock.fn(),
        },
      };

      const result = await editSingleTier(ctx as never, { model: "openai/gpt-4.1", thinkingLevel: "high" }, "big");
      assert.deepEqual(result, { model: "openai/gpt-4.1" });
    });
  });
});
