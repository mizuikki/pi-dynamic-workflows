import assert from "node:assert/strict";
import test from "node:test";
import { generateAdversarialReviewWorkflow } from "../src/adversarial-review.js";
import { generateDeepResearchWorkflow } from "../src/deep-research.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript } from "../src/workflow.js";

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather", "Verify", "Report"],
  );
  // Reads inputs from args (no string interpolation) and uses the web tools.
  assert.match(body, /args && args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateAdversarialReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(meta.name, "adversarial_review");
  assert.match(body, /args && args\.task/);
  // Uses the agreement threshold to decide survivors.
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});
