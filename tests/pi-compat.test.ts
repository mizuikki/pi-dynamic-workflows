import assert from "node:assert/strict";
import test from "node:test";
import { getAvailableModels, getAvailableModelsSync, listAvailableModelSpecsAsync } from "../src/pi-compat.js";

const models = [
  { provider: "explicit", id: "one" },
  { provider: "explicit", id: "two" },
] as never;

test("pi compatibility reads synchronous ModelRegistry-style availability", () => {
  const source = { getAvailable: () => models };
  assert.deepEqual(getAvailableModelsSync(source), models);
});

test("pi compatibility does not pretend an async ModelRuntime source is synchronously available", () => {
  const source = { getAvailable: async () => models };
  assert.deepEqual(getAvailableModelsSync(source), []);
});

test("pi compatibility handles a rejecting async source in the sync path", async () => {
  const source = {
    getAvailable: async () => {
      throw new Error("async auth failed");
    },
  };
  assert.deepEqual(getAvailableModelsSync(source), []);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("pi compatibility awaits asynchronous availability and formats specs", async () => {
  const source = { getAvailable: async () => models };
  assert.deepEqual(await getAvailableModels(source), models);
  assert.deepEqual(await listAvailableModelSpecsAsync(source), ["explicit/one", "explicit/two"]);
});

test("pi compatibility converts availability failures to an empty list", async () => {
  const source = {
    getAvailable: async () => {
      throw new Error("auth failed");
    },
  };
  assert.deepEqual(await getAvailableModels(source), []);
  assert.deepEqual(await listAvailableModelSpecsAsync(source), []);
});
