import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createTrellisContextLoader,
  createTrellisSubagentTool,
  hasNativeTrellisExtension,
  hasRegisteredTrellisSubagentTool,
  hasTrellisProject,
  MAX_TRELLIS_PARALLEL_PROMPTS,
  shouldRegisterTrellisSubagentTool,
  TRELLIS_SUBAGENT_TOOL_NAME,
} from "../src/index.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-dw-trellis-tool-"));
}

function writeTask(cwd: string, name = "04-17-demo"): string {
  const taskDir = join(cwd, ".trellis", "tasks", name);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(cwd, ".trellis", ".version"), "1.0.3\n", "utf-8");
  writeFileSync(join(taskDir, "prd.md"), "# PRD\nImplement the adapter.", "utf-8");
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: name, status: "in_progress" }), "utf-8");
  return taskDir;
}

function writeAgent(
  cwd: string,
  name = "trellis-implement",
  options: { model?: string; thinking?: string } = {},
): void {
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agents", `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "tools: read, bash",
      ...(options.model ? [`model: ${options.model}`] : []),
      ...(options.thinking ? [`thinking: ${options.thinking}`] : []),
      "---",
      "You are a Trellis implement agent.",
    ].join("\n"),
    "utf-8",
  );
}

function mockPi(tools: Array<{ name: string }> = []): ExtensionAPI {
  return {
    getAllTools: () => tools,
  } as unknown as ExtensionAPI;
}

test("D1: auto + no .trellis does not want tool registration", () => {
  const cwd = makeProject();
  try {
    assert.equal(hasTrellisProject(cwd), false);
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "auto" }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D2: getAllTools already has trellis_subagent → hasRegistered true", () => {
  assert.equal(hasRegisteredTrellisSubagentTool(mockPi([{ name: TRELLIS_SUBAGENT_TOOL_NAME }])), true);
  assert.equal(hasRegisteredTrellisSubagentTool(mockPi([{ name: "workflow" }])), false);
});

test("D2b: getAllTools throw fails closed (treat as already registered)", () => {
  const pi = {
    getAllTools: () => {
      throw new Error("notInitialized");
    },
  } as unknown as ExtensionAPI;
  assert.equal(hasRegisteredTrellisSubagentTool(pi), true);
});

test("D3: native trellis extension path → auto skips registration", () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.3\n", "utf-8");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "trellis.ts"), "export default () => {}", "utf-8");
    assert.equal(hasNativeTrellisExtension(cwd), true);
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "auto", registerSubagentTool: "auto" }), false);
    // force on still allows (caller must still check getAllTools)
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "on", registerSubagentTool: "on" }), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D4: single mode returns child text and includes Active task + context in prompt", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    const seen: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
    const agent = {
      async run(prompt: string, opts: Record<string, unknown>) {
        seen.push({ prompt, opts });
        return "child-ok";
      },
    };
    const tool = createTrellisSubagentTool({
      cwd,
      agent,
      contextLoader: createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null }),
      getSessionId: () => "sess-d4",
      settings: { autoPrependActiveTaskLine: true },
    });
    const result = await tool.execute(
      "tc1",
      {
        agent: "trellis-implement",
        mode: "single",
        prompt: "Active task: .trellis/tasks/04-17-demo\nImplement now",
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /child-ok/);
    assert.equal(result.isError, false);
    assert.equal(result.details?.kind, "trellis-subagent-progress");
    assert.ok(seen[0]?.prompt.includes("## Trellis Task Context"));
    assert.ok(seen[0]?.prompt.includes("Implement the adapter."));
    assert.ok(seen[0]?.prompt.includes("## Delegated Task"));
    assert.ok(seen[0]?.prompt.includes("Active task:"));
    assert.equal(
      seen[0]?.prompt.match(/## Trellis Task Context/g)?.length,
      1,
      "context title must appear exactly once",
    );
    assert.equal(seen[0]?.opts.agentType, "trellis-implement");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("accepts the Pi max thinking level for trellis_subagent", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    let thinkingLevel: unknown;
    const tool = createTrellisSubagentTool({
      cwd,
      agent: {
        async run(_prompt, options) {
          thinkingLevel = options.thinkingLevel;
          return "child-ok";
        },
      },
    });
    await tool.execute(
      "tc-max-thinking",
      {
        agent: "trellis-implement",
        mode: "single",
        prompt: "Active task: .trellis/tasks/04-17-demo\nImplement now",
        thinking: "max",
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(thinkingLevel, "max");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("matches native model and thinking precedence while stripping model suffixes", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    const cases = [
      {
        name: "explicit thinking",
        input: { model: "provider/input-model:low", thinking: "max" as const },
        agent: { model: "provider/agent-model:xhigh", thinking: "high" },
        host: "medium",
        expectedModel: "provider/input-model",
        expectedThinking: "max",
      },
      {
        name: "input model suffix",
        input: { model: "provider/input-model:low" },
        agent: { model: "provider/agent-model:xhigh", thinking: "high" },
        host: "medium",
        expectedModel: "provider/input-model",
        expectedThinking: "low",
      },
      {
        name: "agent thinking",
        input: {},
        agent: { model: "provider/agent-model:xhigh", thinking: "medium" },
        host: "low",
        expectedModel: "provider/agent-model",
        expectedThinking: "medium",
      },
      {
        name: "agent model suffix",
        input: {},
        agent: { model: "provider/agent-model:max" },
        host: "low",
        expectedModel: "provider/agent-model",
        expectedThinking: "max",
      },
      {
        name: "host inheritance",
        input: {},
        agent: {},
        host: "xhigh",
        expectedModel: undefined,
        expectedThinking: "xhigh",
      },
    ];

    for (const vector of cases) {
      writeAgent(cwd, "trellis-implement", vector.agent);
      let seen: Record<string, unknown> | undefined;
      const tool = createTrellisSubagentTool({
        cwd,
        agent: {
          async run(_prompt, options) {
            seen = options as unknown as Record<string, unknown>;
            return "child-ok";
          },
        },
        getThinkingLevel: () => vector.host,
      });
      await tool.execute(
        `tc-precedence-${vector.name}`,
        {
          agent: "trellis-implement",
          mode: "single",
          prompt: "Active task: .trellis/tasks/04-17-demo\nImplement now",
          ...vector.input,
        },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal(seen?.model, vector.expectedModel, `${vector.name} model`);
      assert.equal(seen?.thinkingLevel, vector.expectedThinking, `${vector.name} thinking`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D5: parallel joins with --- and runs all prompts", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    const prompts: string[] = [];
    const agent = {
      async run(prompt: string) {
        const m = prompt.match(/## Delegated Task\n([\s\S]*)$/);
        prompts.push((m?.[1] ?? prompt).trim());
        return `out-${prompts.length}`;
      },
    };
    const tool = createTrellisSubagentTool({
      cwd,
      agent,
      getSessionId: () => "sess-d5",
    });
    const result = await tool.execute(
      "tc2",
      {
        agent: "trellis-implement",
        mode: "parallel",
        prompts: ["Active task: .trellis/tasks/04-17-demo\none", "Active task: .trellis/tasks/04-17-demo\ntwo"],
      },
      undefined,
      undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.includes("out-1"));
    assert.ok(text.includes("out-2"));
    assert.ok(text.includes("---"));
    assert.equal(prompts.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D6: chain feeds previous output; stop on failure", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    const seen: string[] = [];
    let n = 0;
    const agent = {
      async run(prompt: string) {
        n++;
        seen.push(prompt);
        if (n === 1) throw new Error("step1-fail");
        return "step2";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent, getSessionId: () => "s" });
    const result = await tool.execute(
      "tc3",
      {
        agent: "trellis-implement",
        mode: "chain",
        prompts: ["Active task: .trellis/tasks/04-17-demo\nfirst", "Active task: .trellis/tasks/04-17-demo\nsecond"],
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(result.isError, true);
    assert.equal(seen.length, 1, "step2 must not run after failure");
    assert.match((result.content[0] as { text: string }).text, /step1-fail/);

    // success path feeds Previous output
    n = 0;
    seen.length = 0;
    const agent2 = {
      async run(prompt: string) {
        n++;
        seen.push(prompt);
        return `r${n}`;
      },
    };
    const tool2 = createTrellisSubagentTool({ cwd, agent: agent2, getSessionId: () => "s" });
    const ok = await tool2.execute(
      "tc4",
      {
        agent: "trellis-implement",
        mode: "chain",
        prompts: ["Active task: .trellis/tasks/04-17-demo\nA", "Active task: .trellis/tasks/04-17-demo\nB"],
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(ok.isError, false);
    assert.equal(seen.length, 2);
    assert.ok(seen[1]?.includes("Previous output:"));
    assert.ok(seen[1]?.includes("r1"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D7: unknown agent returns not-a-trellis-agent error without spawning", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    let spawned = 0;
    const agent = {
      async run() {
        spawned++;
        return "nope";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent });
    const result = await tool.execute(
      "tc5",
      { agent: "trellis-missing", mode: "single", prompt: "hi" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(spawned, 0);
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /No definition found/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D8: registry tools allowlist reaches agent.run", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd); // tools: read, bash
    let toolNames: string[] | undefined;
    const agent = {
      async run(_p: string, opts: { toolNames?: string[] }) {
        toolNames = opts.toolNames;
        return "ok";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent });
    await tool.execute(
      "tc6",
      {
        agent: "trellis-implement",
        prompt: "Active task: .trellis/tasks/04-17-demo\ngo",
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(toolNames, ["read", "bash"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D10: onUpdate receives running + final progress details", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    const agent = {
      async run() {
        return "done";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent });
    const updates: unknown[] = [];
    const result = await tool.execute(
      "tc7",
      {
        agent: "trellis-implement",
        prompt: "Active task: .trellis/tasks/04-17-demo\ngo",
      },
      undefined,
      (u) => updates.push(u),
      {} as never,
    );
    assert.ok(updates.length >= 1);
    const last = updates[updates.length - 1] as { details?: { kind?: string; final?: boolean } };
    assert.equal(result.details?.final, true);
    assert.equal(result.details?.kind, "trellis-subagent-progress");
    assert.ok(last.details?.kind === "trellis-subagent-progress");
    assert.equal(last.details?.final, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D11: parallel > 6 throws", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd);
    const tool = createTrellisSubagentTool({
      cwd,
      agent: {
        async run() {
          return "x";
        },
      },
    });
    const prompts = Array.from({ length: MAX_TRELLIS_PARALLEL_PROMPTS + 1 }, (_, i) => `p${i}`);
    await assert.rejects(
      () =>
        tool.execute(
          "tc8",
          { agent: "trellis-implement", mode: "parallel", prompts },
          undefined,
          undefined,
          {} as never,
        ),
      /at most 6/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing prompt for single throws", async () => {
  const cwd = makeProject();
  try {
    writeAgent(cwd);
    const tool = createTrellisSubagentTool({
      cwd,
      agent: {
        async run() {
          return "x";
        },
      },
    });
    await assert.rejects(
      () => tool.execute("tc9", { agent: "trellis-implement", mode: "single" }, undefined, undefined, {} as never),
      /prompt is required/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registerSubagentTool off never wants registration", () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "auto", registerSubagentTool: "off" }), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("auto + .trellis without native wants registration", () => {
  const cwd = makeProject();
  try {
    mkdirSync(join(cwd, ".trellis"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", ".version"), "1.0.3\n", "utf-8");
    assert.equal(shouldRegisterTrellisSubagentTool(cwd, { enabled: "auto" }), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D12: abort signal cancels before and during run", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd);
    let spawned = 0;
    const agent = {
      async run(_prompt: string, opts: { signal?: AbortSignal }) {
        spawned++;
        if (opts.signal?.aborted) throw new Error("aborted by host");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted mid-run"));
          opts.signal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(() => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 50);
        });
        return "late";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent });

    const pre = new AbortController();
    pre.abort();
    const preResult = await tool.execute(
      "abort-pre",
      {
        agent: "trellis-implement",
        prompt: "Active task: .trellis/tasks/04-17-demo\npre",
      },
      pre.signal,
      undefined,
      {} as never,
    );
    assert.equal(preResult.isError, true);
    assert.match((preResult.content[0] as { text: string }).text, /cancelled|abort/i);
    assert.equal(preResult.details?.runs[0]?.status, "cancelled");

    const mid = new AbortController();
    const midPromise = tool.execute(
      "abort-mid",
      {
        agent: "trellis-implement",
        prompt: "Active task: .trellis/tasks/04-17-demo\nmid",
      },
      mid.signal,
      undefined,
      {} as never,
    );
    setTimeout(() => mid.abort(), 5);
    const midResult = await midPromise;
    assert.equal(midResult.isError, true);
    assert.equal(midResult.details?.runs[0]?.status, "cancelled");
    assert.ok(spawned >= 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D13: implement/check force shared project cwd", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd);
    writeAgent(cwd, "trellis-implement");
    writeAgent(cwd, "trellis-check");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "trellis-research.md"),
      ["---", "name: trellis-research", "tools: read", "---", "Research body."].join("\n"),
      "utf-8",
    );
    const seen: Array<{ agentType?: string; cwd?: string }> = [];
    const agent = {
      async run(_prompt: string, opts: { agentType?: string; cwd?: string }) {
        seen.push({ agentType: opts.agentType, cwd: opts.cwd });
        return "ok";
      },
    };
    const tool = createTrellisSubagentTool({ cwd, agent });
    for (const name of ["trellis-implement", "trellis-check"] as const) {
      await tool.execute(
        `cwd-${name}`,
        {
          agent: name,
          prompt: "Active task: .trellis/tasks/04-17-demo\nwork",
        },
        undefined,
        undefined,
        {} as never,
      );
    }
    await tool.execute(
      "cwd-research",
      {
        agent: "trellis-research",
        prompt: "Active task: .trellis/tasks/04-17-demo\nresearch",
      },
      undefined,
      undefined,
      {} as never,
    );
    const implement = seen.find((s) => s.agentType === "trellis-implement");
    const check = seen.find((s) => s.agentType === "trellis-check");
    const research = seen.find((s) => s.agentType === "trellis-research");
    assert.equal(implement?.cwd, cwd);
    assert.equal(check?.cwd, cwd);
    assert.equal(research?.cwd, undefined, "non-implement/check agents should not force shared cwd");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("D14: auto-prepend uses full repo-relative task path", async () => {
  const cwd = makeProject();
  try {
    writeTask(cwd, "nested-name");
    writeAgent(cwd);
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "pi_sess.json"),
      JSON.stringify({ current_task: ".trellis/tasks/nested-name" }),
      "utf-8",
    );
    let promptSeen = "";
    const agent = {
      async run(prompt: string) {
        promptSeen = prompt;
        return "ok";
      },
    };
    const tool = createTrellisSubagentTool({
      cwd,
      agent,
      getSessionId: () => "sess",
      settings: { autoPrependActiveTaskLine: true },
      resolveTaskPyCurrent: () => null,
    });
    await tool.execute(
      "prepend",
      { agent: "trellis-implement", prompt: "do work without active line" },
      undefined,
      undefined,
      {} as never,
    );
    assert.match(promptSeen, /Active task: \.trellis\/tasks\/nested-name/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
