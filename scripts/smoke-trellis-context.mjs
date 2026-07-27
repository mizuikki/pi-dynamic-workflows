import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTrellisTaskContext,
  createTrellisContextLoader,
  shouldRegisterTrellisSubagentTool,
  trellisExtensionPathFilter,
} from "../dist/adapters/trellis.js";
import { wrapResourceLoaderForWorkflowSubagents } from "../dist/agent.js";

const root = mkdtempSync(join(tmpdir(), "pi-dw-trellis-context-"));
const task = join(root, ".trellis", "tasks", "smoke");
const vectors = [];
const evidence = { host: {}, child: {}, prompts: {}, registration: {} };

function run(id, assertion) {
  assertion();
  vectors.push(id);
}

function payload(agent = "implement") {
  return buildTrellisTaskContext(root, task, agent);
}

function fakeResourceLoader() {
  const extension = (path, tools) => ({
    path,
    resolvedPath: path,
    tools: new Map(tools.map((name) => [name, {}])),
    commands: new Map(),
  });
  const extensions = [
    extension(join(root, ".pi", "extensions", "trellis", "index.ts"), ["trellis_subagent"]),
    extension(join(root, "extensions", "workflow.ts"), ["workflow"]),
    extension(join(root, "extensions", "safe.ts"), ["safe_tool"]),
  ];
  return {
    getExtensions: () => ({ extensions, errors: [] }),
    getSkills: () => [],
    getPrompts: () => [],
    getThemes: () => [],
    getAgentsFiles: () => [],
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => undefined,
    extendResources: () => {},
    reload: () => {},
  };
}

try {
  mkdirSync(join(root, ".pi", "extensions", "trellis"), { recursive: true });
  mkdirSync(task, { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: ["./extensions/trellis/index.ts"] }));
  writeFileSync(join(root, ".trellis", ".version"), "1.0.1\n");
  writeFileSync(join(root, ".pi", "extensions", "trellis", "index.ts"), "export default {};\n");
  writeFileSync(join(task, "prd.md"), "# Requirements\nShip the adapter.\n");
  writeFileSync(join(task, "design.md"), "# Technical Design\nKeep payload bytes stable.\n");
  writeFileSync(join(task, "implement.md"), "# Execution Plan\nRun the vectors.\n");

  run("V01", () => {
    assert.equal(
      payload("research"),
      `## Trellis Task Context\n\nTask directory: .trellis/tasks/smoke\n\n### .trellis/tasks/smoke/prd.md (Requirements)\n# Requirements\nShip the adapter.\n\n\n### .trellis/tasks/smoke/design.md (Technical Design)\n# Technical Design\nKeep payload bytes stable.\n\n\n### .trellis/tasks/smoke/implement.md (Execution Plan)\n# Execution Plan\nRun the vectors.\n`,
    );
  });
  run("V02", () => {
    rmSync(join(task, "prd.md"));
    assert.doesNotMatch(payload("research"), /Requirements/);
    writeFileSync(join(task, "prd.md"), "# Requirements\nShip the adapter.\n");
  });
  run("V03", () => {
    writeFileSync(join(task, "prd.md"), Buffer.alloc(30_000, 0xff));
    assert.ok(Buffer.byteLength(payload("research"), "utf8") <= 128 * 1024);
  });
  run("V04", () => {
    writeFileSync(join(task, "prd.md"), `${"a".repeat(65_535)}é`);
    assert.match(payload("research"), /Truncated .+prd\.md at 65536 UTF-8 bytes/);
  });
  run("V05", () => {
    writeFileSync(join(task, "implement.jsonl"), JSON.stringify({ file: "docs/late.md", reason: "x".repeat(300_000) }));
    assert.match(payload(), /Stopped reading implement\.jsonl after 262144 bytes/);
  });
  mkdirSync(join(root, "docs", "directory"), { recursive: true });
  writeFileSync(join(root, "docs", "file.md"), "file");
  run("V06", () => {
    writeFileSync(
      join(task, "implement.jsonl"),
      ["not-json", JSON.stringify({ file: " ", path: "docs/file.md" })].join("\n"),
    );
    assert.match(payload(), /path: docs\/file\.md \| type: file \| bytes: 4/);
  });
  run("V07", () => {
    writeFileSync(join(task, "implement.jsonl"), JSON.stringify({ file: "docs/file.md", path: "docs/other.md" }));
    assert.doesNotMatch(payload(), /docs\/other\.md/);
  });
  run("V08", () => {
    writeFileSync(
      join(task, "implement.jsonl"),
      [JSON.stringify({ file: "docs/directory", type: "directory" }), JSON.stringify({ file: "docs/missing.md" })].join(
        "\n",
      ),
    );
    assert.match(payload(), /type: directory/);
    assert.match(payload(), /status: missing-or-unreadable/);
  });
  run("V09", () => {
    symlinkSync(join(root, "docs", "file.md"), join(root, "docs", "alias.md"));
    writeFileSync(
      join(task, "implement.jsonl"),
      [JSON.stringify({ file: "docs/alias.md" }), JSON.stringify({ file: "docs/file.md" })].join("\n"),
    );
    assert.equal(payload().match(/path: docs\/file\.md/g)?.length, 1);
  });
  run("V10", () => {
    const rows = [];
    for (let index = 0; index < 257; index += 1)
      rows.push(JSON.stringify({ path: `docs/${index}.md`, reason: "r".repeat(240) }));
    writeFileSync(join(task, "implement.jsonl"), rows.join("\n"));
    assert.match(payload(), /Truncated rendered index for implement\.jsonl/);
  });
  run("V11", () => {
    writeFileSync(
      join(task, "implement.jsonl"),
      JSON.stringify({ file: "docs/file.md", reason: `\ud800${"😀".repeat(250)}` }),
    );
    assert.match(payload(), /reason: �😀/);
  });
  run("V12", () => {
    const notice =
      "[Task context for .trellis/tasks/smoke exceeded 131072 bytes; artifact limits applied to none; load the remaining task artifacts and manifest sources on demand.]";
    writeFileSync(join(task, "prd.md"), notice);
    assert.equal(payload("research").split(notice).length - 1, 1);
  });

  // Capture the child prompt from a clean task state rather than the final
  // boundary vector, whose deliberately unusual artifact would obscure it.
  rmSync(join(task, "implement.jsonl"), { force: true });
  writeFileSync(join(task, "prd.md"), "# Requirements\nShip the adapter.\n");
  writeFileSync(join(task, "design.md"), "# Technical Design\nKeep payload bytes stable.\n");
  writeFileSync(join(task, "implement.md"), "# Execution Plan\nRun the vectors.\n");

  const hostLoader = fakeResourceLoader();
  const hostExtensions = hostLoader.getExtensions().extensions;
  const childExtensions = wrapResourceLoaderForWorkflowSubagents(hostLoader, {
    extensionPathFilters: [trellisExtensionPathFilter],
  }).getExtensions().extensions;
  evidence.host = {
    extensionPaths: hostExtensions.map((item) => item.path),
    toolNames: hostExtensions.flatMap((item) => [...item.tools.keys()]),
  };
  evidence.child = {
    extensionPaths: childExtensions.map((item) => item.path),
    toolNames: childExtensions.flatMap((item) => [...item.tools.keys()]),
  };
  assert.deepEqual(evidence.child.toolNames, ["safe_tool"]);
  assert.equal(evidence.child.extensionPaths.length, 1);

  const loader = createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null });
  const active = await loader({
    cwd: root,
    agentType: "trellis-implement",
    prompt: "Active task: .trellis/tasks/smoke\nwork",
    sessionId: "smoke",
  });
  const inactive = await loader({ cwd: root, agentType: "trellis-implement", prompt: "work", sessionId: "no-task" });
  const activePrompt = `${active?.promptPrefix ?? ""}\n\n## Delegated Task\nwork`;
  evidence.prompts = {
    activeTitleCount: (activePrompt.match(/## Trellis Task Context/g) ?? []).length,
    noTaskTitleCount: ((inactive?.promptPrefix ?? "").match(/## Trellis Task Context/g) ?? []).length,
    finalPrompt: activePrompt,
  };
  assert.equal(evidence.prompts.activeTitleCount, 1);
  assert.equal(evidence.prompts.noTaskTitleCount, 0);

  evidence.registration = {
    nativePresent: shouldRegisterTrellisSubagentTool(root, { enabled: "auto", registerSubagentTool: "auto" }),
  };
  assert.equal(evidence.registration.nativePresent, false);
  rmSync(join(root, ".pi", "extensions", "trellis"), { recursive: true, force: true });
  evidence.registration.workflowFallback = shouldRegisterTrellisSubagentTool(root, {
    enabled: "auto",
    registerSubagentTool: "auto",
  });
  assert.equal(evidence.registration.workflowFallback, true);

  process.stdout.write(`${JSON.stringify({ status: "PASS", vectors, evidence })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
