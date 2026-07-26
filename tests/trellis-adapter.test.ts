import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTrellisTaskContext,
  createTrellisContextLoader,
  hasSupportedTrellisProject,
  hasTrellisProject,
  isTrellisAgent,
  MAX_TRELLIS_TASK_CONTEXT_BYTES,
  parseActiveTaskLine,
  resolveActiveTaskPath,
  shouldEnableTrellisAdapter,
  shouldRegisterTrellisSubagentTool,
  trellisExtensionPathFilter,
} from "../src/adapters/trellis.js";
import { runWorkflow } from "../src/workflow.js";
import { loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";
import {
  TRELLIS_1_0_1_LIMITS,
  TRELLIS_1_0_1_NOTICES,
  TRELLIS_1_0_1_TEMPLATE_SHA256,
  trellisArtifactNotice,
  V01_TRELLIS_1_0_1_PAYLOAD,
  writeCanonicalTaskFixture,
} from "./fixtures/trellis-1.0.1-context.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-dw-trellis-"));
}

function writeTask(cwd: string, name = "04-17-demo"): string {
  const taskDir = join(cwd, ".trellis", "tasks", name);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(cwd, ".trellis", ".version"), "1.0.1\n", "utf-8");
  writeFileSync(join(taskDir, "prd.md"), "# PRD\nImplement the adapter.", "utf-8");
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: name, status: "in_progress" }), "utf-8");
  return taskDir;
}

test("V01: canonical 1.0.1 fixture payload is byte-identical", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeCanonicalTaskFixture(cwd);
    assert.equal(buildTrellisTaskContext(cwd, taskDir, "trellis-research"), V01_TRELLIS_1_0_1_PAYLOAD);
    assert.match(TRELLIS_1_0_1_TEMPLATE_SHA256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V02: missing artifacts do not create synthetic sections", () => {
  const cwd = makeProject();
  try {
    const taskDir = join(cwd, ".trellis", "tasks", "missing-prd");
    mkdirSync(taskDir, { recursive: true });
    assert.equal(
      buildTrellisTaskContext(cwd, taskDir, "trellis-research"),
      "## Trellis Task Context\n\nTask directory: .trellis/tasks/missing-prd",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V03: invalid UTF-8 stays within the rendered artifact ceiling", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "invalid-utf8");
    writeFileSync(join(taskDir, "prd.md"), Buffer.alloc(30_000, 0xff));
    const payload = buildTrellisTaskContext(cwd, taskDir, "trellis-research");
    assert.ok(payload.includes(trellisArtifactNotice(".trellis/tasks/invalid-utf8/prd.md")));
    assert.ok(Buffer.byteLength(payload, "utf8") <= TRELLIS_1_0_1_LIMITS.taskContext);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V04: a partial multi-byte boundary is bounded with the canonical notice", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "multibyte");
    writeFileSync(join(taskDir, "prd.md"), `${"a".repeat(65_535)}é`, "utf-8");
    const payload = buildTrellisTaskContext(cwd, taskDir, "trellis-research");
    assert.ok(payload.includes(trellisArtifactNotice(".trellis/tasks/multibyte/prd.md")));
    assert.ok(Buffer.byteLength(payload, "utf8") <= TRELLIS_1_0_1_LIMITS.taskContext);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V05: a source-truncated manifest retains its on-demand notice", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "source-truncated");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "docs/late.md", reason: "x".repeat(300_000) }),
    );
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.match(payload, /implement\.jsonl candidate context index/);
    assert.ok(payload.includes(TRELLIS_1_0_1_NOTICES.manifestSource));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V06: malformed rows are skipped and legacy path rows remain valid", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "legacy-path");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "legacy.md"), "legacy", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      ["not-json", JSON.stringify({ file: " ", path: "docs/legacy.md" })].join("\n"),
    );
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.match(payload, /path: docs\/legacy\.md \| type: file \| bytes: 6/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V07: file has precedence over path", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "file-precedence");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "file.md"), "file", "utf-8");
    writeFileSync(join(cwd, "docs", "path.md"), "path", "utf-8");
    writeFileSync(join(taskDir, "implement.jsonl"), JSON.stringify({ file: "docs/file.md", path: "docs/path.md" }));
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.match(payload, /path: docs\/file\.md/);
    assert.doesNotMatch(payload, /path: docs\/path\.md/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V08: declared directories and missing targets retain metadata rows", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "directory-missing");
    mkdirSync(join(cwd, "docs", "directory"), { recursive: true });
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [JSON.stringify({ file: "docs/directory", type: "directory" }), JSON.stringify({ file: "docs/missing.md" })].join(
        "\n",
      ),
    );
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.match(payload, /path: docs\/directory \| type: directory \| revision:/);
    assert.match(payload, /path: docs\/missing\.md \| type: file \| status: missing-or-unreadable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V09: realpath aliases are deduplicated by their canonical target", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "aliases");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "target.md"), "target", "utf-8");
    symlinkSync(join(cwd, "docs", "target.md"), join(cwd, "docs", "alias.md"));
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [
        JSON.stringify({ file: "docs/alias.md", reason: "first" }),
        JSON.stringify({ file: "docs/target.md", reason: "second" }),
      ].join("\n"),
    );
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.equal(payload.match(/path: docs\/target\.md/g)?.length, 1);
    assert.match(payload, /reason: first/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V10: manifest and aggregate ceilings retain canonical limit notices", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "limits");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    const rows: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      const name = `docs/${index}.md`;
      writeFileSync(join(cwd, name), "x", "utf-8");
      rows.push(JSON.stringify({ file: name, reason: "r".repeat(240) }));
    }
    writeFileSync(join(taskDir, "implement.jsonl"), rows.join("\n"));
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.ok(Buffer.byteLength(payload, "utf8") <= TRELLIS_1_0_1_LIMITS.taskContext);
    assert.ok(payload.includes(TRELLIS_1_0_1_NOTICES.manifestRendered));
    assert.ok(payload.includes(TRELLIS_1_0_1_NOTICES.manifestEntry));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V11: reasons sanitize lone surrogates and preserve emoji boundaries", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "reasons");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "reason.md"), "x", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "docs/reason.md", reason: `\ud800${"😀".repeat(250)}` }),
    );
    const payload = buildTrellisTaskContext(cwd, taskDir, "implement");
    assert.match(payload, /reason: �😀/);
    assert.ok(payload.includes("..."));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("V12: artifact notice text does not trigger an aggregate notice", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd, "notice-text");
    const notice =
      "[Task context for .trellis/tasks/notice-text exceeded 131072 bytes; artifact limits applied to none; load the remaining task artifacts and manifest sources on demand.]";
    writeFileSync(join(taskDir, "prd.md"), notice, "utf-8");
    const payload = buildTrellisTaskContext(cwd, taskDir, "trellis-research");
    assert.equal(payload.split(notice).length - 1, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T15: without .trellis loader stays inactive under auto", async () => {
  const cwd = makeProject();
  try {
    assert.equal(hasTrellisProject(cwd), false);
    assert.equal(shouldEnableTrellisAdapter(cwd, { enabled: "auto" }), false);
    const loader = createTrellisContextLoader({ enabled: "auto" });
    const ctx = await loader({ cwd, prompt: "Active task: .trellis/tasks/x\ndo work", agentType: "trellis-implement" });
    assert.equal(ctx, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T15b: every adapter entry point rejects a missing or incompatible Trellis version", async () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".trellis", "tasks", "unsupported"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "0.6.7\n", "utf-8");
    assert.equal(hasSupportedTrellisProject(cwd), false);
    assert.equal(shouldEnableTrellisAdapter(cwd, { enabled: "auto" }), false);
    assert.equal(shouldEnableTrellisAdapter(cwd, { enabled: "on" }), false);
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "on", registerSubagentTool: "on" }), false);
    const loader = createTrellisContextLoader({ enabled: "on" });
    assert.equal(
      await loader({ cwd, prompt: "Active task: .trellis/tasks/unsupported\nwork", agentType: "trellis-implement" }),
      undefined,
    );
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.1\n", "utf-8");
    assert.equal(hasSupportedTrellisProject(cwd), true);
    assert.equal(shouldEnableTrellisAdapter(cwd, { enabled: "on" }), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T16: Active task line injects Trellis Task Context with prd", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const loader = createTrellisContextLoader({ enabled: "on", autoPrependActiveTaskLine: true });
    const ctx = await loader({
      cwd,
      agentType: "trellis-implement",
      prompt: "Active task: .trellis/tasks/04-17-demo\nImplement now",
    });
    assert.ok(ctx?.promptPrefix?.includes("## Trellis Task Context"));
    assert.ok(ctx?.promptPrefix?.includes("Implement the adapter."));
    assert.ok(ctx?.promptPrefix?.includes("### .trellis/tasks/04-17-demo/prd.md (Requirements)"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T17: only prd present does not block; missing design/implement/jsonl ok", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("### .trellis/tasks/04-17-demo/prd.md (Requirements)"));
    assert.ok(!text.includes("Technical Design"));
    assert.ok(!text.includes("Execution Plan"));
    assert.ok(!text.includes("candidate context index"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18: jsonl renders canonical metadata rows; _example is metadata, not a skip marker", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "note.md"), "SPEC BODY", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [
        // A usable `_example` path is still rendered; only absent/invalid paths are skipped.
        JSON.stringify({ _example: true, file: "docs/ignore.md", reason: "seed" }),
        "not-json",
        JSON.stringify({ file: "docs/note.md", reason: "real" }),
        JSON.stringify({ reason: "missing file key" }),
      ].join("\n"),
      "utf-8",
    );
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("### implement.jsonl candidate context index (load sources on demand)"));
    assert.match(text, /path: docs\/note\.md \| type: file \| bytes: 9 \| revision: \d+(?:\.\d+)? \| reason: real/);
    assert.ok(!text.includes("SPEC BODY"));
    assert.ok(text.includes("docs/ignore.md"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18b: manifest deduplicates paths and never inlines large referenced files", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "large.md"), "LARGE_SECRET\n".repeat(40_000), "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [
        JSON.stringify({ file: "docs/large.md", reason: "first" }),
        JSON.stringify({ file: "./docs/large.md", reason: "duplicate" }),
      ].join("\n"),
      "utf-8",
    );
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.equal(text.match(/path: docs\/large\.md/g)?.length, 1);
    assert.ok(!text.includes("LARGE_SECRET"));
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_TRELLIS_TASK_CONTEXT_BYTES);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18c: a truncated manifest with no parsed rows retains its on-demand pointer", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "docs/late.md", reason: "R".repeat(300 * 1024) }),
      "utf-8",
    );
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("### implement.jsonl candidate context index (load sources on demand)"));
    assert.ok(text.includes("Stopped reading implement.jsonl after 262144 bytes; load the remainder on demand."));
    assert.ok(!text.includes("`docs/late.md`"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18d: oversized task artifacts are bounded with an on-demand notice", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    writeFileSync(join(taskDir, "prd.md"), "大型需求\n".repeat(50_000), "utf-8");
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.match(text, /Truncated \.trellis\/tasks\/04-17-demo\/prd\.md at 65536 UTF-8 bytes/);
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_TRELLIS_TASK_CONTEXT_BYTES);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18e: combined task artifacts cannot exceed the total context budget", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    for (const fileName of ["prd.md", "design.md", "implement.md"]) {
      writeFileSync(join(taskDir, fileName), `${fileName} body\n`.repeat(10_000), "utf-8");
    }
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.match(text, /Task context for \.trellis\/tasks\/04-17-demo exceeded 131072 bytes/);
    assert.equal(Buffer.byteLength(text, "utf8"), MAX_TRELLIS_TASK_CONTEXT_BYTES);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18f: referenced-file metadata revisions invalidate context even when byte size is unchanged", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    const referenced = join(cwd, "docs", "same-size.md");
    writeFileSync(referenced, "AAAA", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "docs/same-size.md", reason: "hash me" }),
      "utf-8",
    );
    const before = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    writeFileSync(referenced, "BBBB", "utf-8");
    const after = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.notEqual(before, after);
    assert.ok(!after.includes("BBBB"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T19: research agentType does not attach jsonl map", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    writeFileSync(join(taskDir, "implement.jsonl"), JSON.stringify({ file: "docs/note.md" }), "utf-8");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "note.md"), "SPEC", "utf-8");
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-research");
    assert.ok(!text.includes("Curated Spec"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T20: multiple sessions with tasks fail closed", () => {
  const cwd = makeProject();
  try {
    writeTask(cwd, "task-a");
    writeTask(cwd, "task-b");
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s1.json"), JSON.stringify({ current_task: ".trellis/tasks/task-a" }), "utf-8");
    writeFileSync(join(sessions, "s2.json"), JSON.stringify({ current_task: ".trellis/tasks/task-b" }), "utf-8");
    const warnings: string[] = [];
    const path = resolveActiveTaskPath(cwd, "no active task line", undefined, {}, (m) => warnings.push(m));
    assert.equal(path, undefined);
    assert.ok(warnings.some((w) => w.includes("refusing to guess")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T21: task.py current --source fallback via injectable resolver", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const loader = createTrellisContextLoader({
      enabled: "on",
      resolveTaskPyCurrent: () => ".trellis/tasks/04-17-demo",
    });
    const ctx = await loader({ cwd, prompt: "do work", agentType: "trellis-implement" });
    assert.ok(ctx?.promptPrefix?.includes("Active task: .trellis/tasks/04-17-demo"));
    assert.ok(ctx?.promptPrefix?.includes("## Trellis Task Context"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T22: trellis extension path filter matches trellis paths", () => {
  assert.equal(trellisExtensionPathFilter("/proj/.pi/extensions/trellis/index.ts"), true);
  assert.equal(trellisExtensionPathFilter("/proj/extensions/trellis.ts"), true);
  assert.equal(trellisExtensionPathFilter("/proj/extensions/workflow.ts"), false);
  assert.equal(trellisExtensionPathFilter("/proj/extensions/safe.ts"), false);
});

test("T23: adapter never spawns task.py lifecycle commands", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const spawned: string[][] = [];
    const loader = createTrellisContextLoader({
      enabled: "on",
      resolveTaskPyCurrent: (projectCwd) => {
        // Simulate the only allowed read path by not spawning; record that lifecycle was not requested.
        spawned.push(["task.py", "current", "--source", projectCwd]);
        return ".trellis/tasks/04-17-demo";
      },
    });
    await loader({ cwd, prompt: "work", agentType: "trellis-implement" });
    for (const args of spawned) {
      assert.ok(!args.includes("create"));
      assert.ok(!args.includes("start"));
      assert.ok(!args.includes("finish"));
      assert.ok(!args.includes("archive"));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T24: workflow agentType tools reach runner for trellis-implement style allowlist", async () => {
  let observed: string[] | undefined;
  const agent = {
    async run(_prompt: string, opts: { toolNames?: string[] }) {
      observed = opts.toolNames;
      return "ok";
    },
  };
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "trellis-implement.md"),
      ["---", "name: trellis-implement", "tools: read, write, edit, bash, find, grep", "---", "Implement body."].join(
        "\n",
      ),
      "utf-8",
    );
    writeTask(cwd);
    await runWorkflow(
      `export const meta = { name: 't24', description: 't' };
       return await agent('Active task: .trellis/tasks/04-17-demo\\ndo it', { agentType: 'trellis-implement' });`,
      {
        cwd,
        agent,
        persistLogs: false,
        contextLoader: createTrellisContextLoader({ enabled: "on" }),
      },
    );
    assert.deepEqual(observed, ["read", "write", "edit", "bash", "find", "grep"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseActiveTaskLine extracts first Active task path", () => {
  assert.equal(parseActiveTaskLine("Active task: .trellis/tasks/foo\nrest"), ".trellis/tasks/foo");
  assert.equal(parseActiveTaskLine("nope"), undefined);
});

test("workflow settings normalize trellisAdapter", () => {
  const dir = makeProject();
  try {
    const settingsPath = join(dir, "settings.json");
    saveWorkflowSettings(
      {
        trellisAdapter: {
          enabled: "auto",
          autoPrependActiveTaskLine: false,
          registerSubagentTool: "off",
        },
      },
      settingsPath,
    );
    assert.deepEqual(loadWorkflowSettings(settingsPath).trellisAdapter, {
      enabled: "auto",
      autoPrependActiveTaskLine: false,
      registerSubagentTool: "off",
    });
    writeFileSync(settingsPath, JSON.stringify({ trellisAdapter: { enabled: "nope", extra: 1 } }), "utf-8");
    assert.equal(loadWorkflowSettings(settingsPath).trellisAdapter, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single session adopt resolves task when prompt line missing", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "only.json"), JSON.stringify({ current_task: ".trellis/tasks/04-17-demo" }), "utf-8");
    const loader = createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null });
    const ctx = await loader({ cwd, prompt: "work", agentType: "trellis-implement" });
    assert.ok(ctx?.promptPrefix?.includes("04-17-demo"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an invalid prompt task does not fall through to a valid session task", () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "pi_abc123.json"),
      JSON.stringify({ current_task: ".trellis/tasks/04-17-demo" }),
      "utf-8",
    );
    assert.equal(
      resolveActiveTaskPath(cwd, "Active task: ../unsafe-task", "abc123", {}, () => {}),
      undefined,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("path safety: absolute and .. task refs outside cwd are rejected", () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const outside = join(tmpdir(), "pi-dw-outside-task");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "prd.md"), "SECRET", "utf-8");
    assert.equal(
      resolveActiveTaskPath(cwd, `Active task: ${outside}`, undefined, {}, () => {}),
      undefined,
    );
    assert.equal(
      resolveActiveTaskPath(cwd, "Active task: ../pi-dw-outside-task", undefined, {}, () => {}),
      undefined,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("path safety: jsonl file rows cannot escape project cwd", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    const outside = join(tmpdir(), "pi-dw-secret-file.md");
    writeFileSync(outside, "TOP SECRET", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [
        JSON.stringify({ file: outside }),
        JSON.stringify({ file: "../pi-dw-secret-file.md" }),
        JSON.stringify({ file: "docs/ok.md" }),
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "ok.md"), "SAFE", "utf-8");
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("path: docs/ok.md"));
    assert.ok(!text.includes("SAFE"));
    assert.ok(!text.includes("TOP SECRET"));
    assert.ok(!text.includes("pi-dw-secret-file.md"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("path safety: canonical checks reject task, spec, and agent symlinks outside the project", () => {
  const cwd = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "pi-dw-trellis-symlink-outside-"));
  try {
    mkdirSync(join(cwd, ".trellis", "tasks"), { recursive: true });
    writeFileSync(join(outside, "prd.md"), "OUTSIDE TASK", "utf-8");
    symlinkSync(outside, join(cwd, ".trellis", "tasks", "linked"));
    assert.equal(
      resolveActiveTaskPath(cwd, "Active task: .trellis/tasks/linked", undefined, {}, () => {}),
      undefined,
    );

    const taskDir = writeTask(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(outside, "secret.md"), "OUTSIDE SPEC", "utf-8");
    symlinkSync(join(outside, "secret.md"), join(cwd, "docs", "linked.md"));
    writeFileSync(join(taskDir, "implement.jsonl"), JSON.stringify({ file: "docs/linked.md" }), "utf-8");
    assert.doesNotMatch(buildTrellisTaskContext(cwd, taskDir, "trellis-implement"), /OUTSIDE SPEC/);

    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    symlinkSync(join(outside, "secret.md"), join(cwd, ".pi", "agents", "trellis-linked.md"));
    assert.equal(isTrellisAgent(cwd, "trellis-linked"), false);
    assert.equal(isTrellisAgent(cwd, "../../secret"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("path safety: default task.py resolution rejects scripts symlinked outside the project", async () => {
  const cwd = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "pi-dw-trellis-script-outside-"));
  try {
    writeTask(cwd);
    mkdirSync(join(cwd, ".trellis", "scripts"), { recursive: true });
    const outsideScript = join(outside, "task.py");
    writeFileSync(outsideScript, 'print("Current task: .trellis/tasks/04-17-demo")\n', "utf-8");
    symlinkSync(outsideScript, join(cwd, ".trellis", "scripts", "task.py"));

    const loader = createTrellisContextLoader({ enabled: "on" });
    const ctx = await loader({ cwd, prompt: "work", agentType: "trellis-implement" });
    assert.equal(ctx, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sessionId resolves pi_<id> Trellis session map key", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "pi_abc123.json"),
      JSON.stringify({ current_task: ".trellis/tasks/04-17-demo" }),
      "utf-8",
    );
    const loader = createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null });
    const ctx = await loader({
      cwd,
      prompt: "work",
      agentType: "trellis-implement",
      sessionId: "abc123",
    });
    assert.ok(ctx?.promptPrefix?.includes("04-17-demo"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loader returns env.TRELLIS_CONTEXT_ID when sessionId resolves", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "pi_abc123.json"),
      JSON.stringify({ current_task: ".trellis/tasks/04-17-demo" }),
      "utf-8",
    );
    const loader = createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null });
    const ctx = await loader({
      cwd,
      prompt: "work",
      agentType: "trellis-implement",
      sessionId: "abc123",
    });
    assert.equal(ctx?.env?.TRELLIS_CONTEXT_ID, "pi_abc123");
    assert.ok(ctx?.promptPrefix?.includes("04-17-demo"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("applySubagentContext still only mutates prompt/instructions; env is separate", async () => {
  const { applySubagentContext } = await import("../src/subagent-context.js");
  const applied = applySubagentContext("body", "role", {
    promptPrefix: "PREFIX",
    instructions: "EXTRA",
    env: { TRELLIS_CONTEXT_ID: "k" },
  });
  assert.equal(applied.prompt, "PREFIX\n\nbody");
  assert.equal(applied.instructions, "role\n\nEXTRA");
});

test("force shared cwd for trellis-implement even when def isolation is worktree", async () => {
  const seen: Array<{ agentType?: string; cwd?: string }> = [];
  const agent = {
    async run(_prompt: string, opts: { agentType?: string; cwd?: string }) {
      seen.push({ agentType: opts.agentType, cwd: opts.cwd });
      return "ok";
    },
  };
  const cwd = makeProject();
  try {
    // Need a real git repo for worktree isolation of the control agent.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd, stdio: "ignore" });
    writeFileSync(join(cwd, "README.md"), "x", "utf-8");
    execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });

    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "trellis-implement.md"),
      ["---", "name: trellis-implement", "tools: read, bash", "isolation: worktree", "---", "Implement body."].join(
        "\n",
      ),
      "utf-8",
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "isolated-reviewer.md"),
      ["---", "name: isolated-reviewer", "tools: read", "isolation: worktree", "---", "Review body."].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "implement.md"),
      ["---", "name: implement", "tools: read", "isolation: worktree", "---", "Generic implement body."].join("\n"),
      "utf-8",
    );
    writeTask(cwd);
    await runWorkflow(
      `export const meta = { name: 'shared-cwd', description: 't' };
       await agent('Active task: .trellis/tasks/04-17-demo\\nimplement', { agentType: 'trellis-implement' });
       await agent('generic implementation', { agentType: 'implement' });
       return await agent('review', { agentType: 'isolated-reviewer' });`,
      {
        cwd,
        agent,
        persistLogs: false,
        contextLoader: createTrellisContextLoader({ enabled: "on" }),
      },
    );
    const implement = seen.find((entry) => entry.agentType === "trellis-implement");
    const genericImplement = seen.find((entry) => entry.agentType === "implement");
    const review = seen.find((entry) => entry.agentType === "isolated-reviewer");
    assert.ok(implement, "implement run should happen");
    assert.ok(review, "review run should happen");
    assert.ok(genericImplement, "generic implement run should happen");
    assert.equal(implement?.cwd, undefined, "trellis-implement must stay on shared project cwd");
    assert.ok(
      genericImplement?.cwd && genericImplement.cwd !== cwd,
      `generic implement should preserve worktree isolation; got ${genericImplement?.cwd}`,
    );
    assert.ok(review?.cwd && review.cwd !== cwd, `isolated-reviewer should receive worktree cwd; got ${review?.cwd}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
