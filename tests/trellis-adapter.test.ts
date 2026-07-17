import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTrellisTaskContext,
  createTrellisContextLoader,
  hasTrellisProject,
  isTrellisAgent,
  MAX_TRELLIS_TASK_CONTEXT_BYTES,
  parseActiveTaskLine,
  resolveActiveTaskPath,
  shouldEnableTrellisAdapter,
  trellisExtensionPathFilter,
} from "../src/adapters/trellis.js";
import { runWorkflow } from "../src/workflow.js";
import { loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-dw-trellis-"));
}

function writeTask(cwd: string, name = "04-17-demo"): string {
  const taskDir = join(cwd, ".trellis", "tasks", name);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD\nImplement the adapter.", "utf-8");
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: name, status: "in_progress" }), "utf-8");
  return taskDir;
}

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
    assert.ok(ctx?.promptPrefix?.includes("### prd.md"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T17: only prd present does not block; missing design/implement/jsonl ok", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("### prd.md"));
    assert.ok(!text.includes("### design.md"));
    assert.ok(!text.includes("### implement.md"));
    assert.ok(!text.includes("Curated Spec"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18: jsonl renders a read-on-demand manifest and skips _example / illegal JSON", () => {
  const cwd = makeProject();
  try {
    const taskDir = writeTask(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "note.md"), "SPEC BODY", "utf-8");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      [
        JSON.stringify({ _example: true, file: "docs/ignore.md", reason: "seed" }),
        "not-json",
        JSON.stringify({ file: "docs/note.md", reason: "real" }),
        JSON.stringify({ reason: "missing file key" }),
      ].join("\n"),
      "utf-8",
    );
    const text = buildTrellisTaskContext(cwd, taskDir, "trellis-implement");
    assert.ok(text.includes("Curated Spec / Research Manifest"));
    assert.match(text, /`docs\/note\.md` \(9 bytes, rev [0-9a-f]{12}\): real/);
    assert.ok(!text.includes("SPEC BODY"));
    assert.ok(!text.includes("docs/ignore.md"));
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
    assert.equal(text.match(/`docs\/large\.md`/g)?.length, 1);
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
    assert.ok(text.includes("Curated Spec / Research Manifest"));
    assert.ok(text.includes("additional entries omitted; inspect `implement.jsonl` directly"));
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
    assert.match(text, /prd\.md truncated at 65536 bytes/);
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
    assert.match(text, /Trellis task context truncated at 131072 bytes/);
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
    assert.ok(text.includes("`docs/ok.md`"));
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
