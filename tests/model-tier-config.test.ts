/**
 * Tests for model-tier-config.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.js");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model and inherits thinking", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(cfg.tiers, {
        small: { model: "openai/gpt-4.1" },
        medium: { model: "openai/gpt-4.1" },
        big: { model: "openai/gpt-4.1" },
      });
    });

    it("always produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
    });
  });

  describe("resolve helpers", () => {
    it("returns the model and thinking level for a valid tier", async () => {
      const { resolveTierModel, resolveTierThinkingLevel } = await loadModule();
      const config = {
        tiers: {
          small: { model: "openai/gpt-4.1-mini", thinkingLevel: "low" },
          medium: { model: "openai/gpt-4.1" },
          big: { model: "openai/gpt-5", thinkingLevel: "high" },
        },
      };
      assert.equal(resolveTierModel("small", config), "openai/gpt-4.1-mini");
      assert.equal(resolveTierModel("medium", config), "openai/gpt-4.1");
      assert.equal(resolveTierThinkingLevel("small", config), "low");
      assert.equal(resolveTierThinkingLevel("medium", config), undefined);
      assert.equal(resolveTierThinkingLevel("big", config), "high");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel, resolveTierThinkingLevel } = await loadModule();
      assert.equal(resolveTierModel("nonexistent", { tiers: { small: { model: "gpt-4.1-mini" } } }), undefined);
      assert.equal(resolveTierThinkingLevel("nonexistent", { tiers: { small: { model: "gpt-4.1-mini" } } }), undefined);
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig (scoped to tmpdir)", () => {
    it("round-trips a valid object config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = {
        tiers: {
          small: { model: "gpt-4.1-mini", thinkingLevel: "low" },
          medium: { model: "gpt-4.1" },
          big: { model: "gpt-5", thinkingLevel: "high" },
        },
      };
      saveModelTierConfig(config, cfgPath);
      const loaded = loadModelTierConfig(cfgPath);
      assert.deepEqual(loaded, config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts legacy string tier values and normalizes them", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": "gpt-4.1-mini"}}', "utf-8");
      const result = loadModelTierConfig(cfgPath);
      assert.deepEqual(result, { tiers: { small: { model: "gpt-4.1-mini" } } });
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "nonexistent-test-file.json")), null);
    });

    it("returns null for corrupted JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, "{invalid json", "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for non-object JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '"just a string"', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when tiers is not an object", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": "not-an-object"}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when a tier object is malformed", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": {"thinkingLevel": "high"}}}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("returns names sorted: small < medium < big", async () => {
      const { sortedTierNames } = await loadModule();
      const config = {
        tiers: {
          big: { model: "gpt-5" },
          small: { model: "gpt-4.1-mini" },
          medium: { model: "gpt-4.1" },
        },
      };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "big"]);
    });

    it("places custom tier names alphabetically after the standard ones", async () => {
      const { sortedTierNames } = await loadModule();
      const config = {
        tiers: {
          xlarge: { model: "gpt-5" },
          medium: { model: "gpt-4.1" },
          small: { model: "gpt-4.1-mini" },
        },
      };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "xlarge"]);
    });
  });
});
