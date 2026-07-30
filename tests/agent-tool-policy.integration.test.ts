/**
 * Real-session integration tests for SDK-level tool allowlist / trust / isolation hash.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  filterShadowingBuiltinCustomTools,
  resolveSessionToolAllowlist,
  WorkflowAgent,
  wrapResourceLoaderForWorkflowSubagents,
} from "../src/agent.js";
import { normalizeHostRetryPolicySnapshot } from "../src/retry-policy.js";
import { createSharedStoreTools, SharedStore } from "../src/shared-store.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels, createFauxRuntimeBundle } from "./helpers/faux-models.js";

function sortUnique(names: string[]): string[] {
  return [...new Set(names)].sort();
}

async function withAgentSession(
  fn: (ctx: {
    cwd: string;
    agentDir: string;
    faux: ReturnType<typeof createExplicitFauxModels>;
    modelRuntime: Awaited<ReturnType<typeof createFauxRuntimeBundle>>["modelRuntime"];
    registry: Awaited<ReturnType<typeof createFauxRuntimeBundle>>["modelRegistry"];
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tools-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tools-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "tool-policy", name: "Tool Policy Faux", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      await fn({ cwd, agentDir, faux, modelRuntime, registry: modelRegistry });
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("resolveSessionToolAllowlist merges system + structured_output names", () => {
  assert.equal(resolveSessionToolAllowlist({}), undefined);
  assert.deepEqual(
    sortUnique(
      resolveSessionToolAllowlist({
        toolNames: ["read"],
        systemToolNames: ["store_put", "store_get"],
        includeStructuredOutput: true,
      }) ?? [],
    ),
    ["read", "store_get", "store_put", "structured_output"],
  );
});

test("T1: tools: [read] keeps only read (+ system/schema) and excludes bash/edit/write", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const store = new SharedStore();
    const systemTools = createSharedStoreTools(store);
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const allow = resolveSessionToolAllowlist({
      toolNames: ["read"],
      systemToolNames: systemTools.map((t) => t.name),
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      model: faux.model,
      modelRuntime,
      tools: allow,
      customTools: systemTools as never,
    });
    try {
      const names = sortUnique(session.getActiveToolNames());
      assert.ok(names.includes("read"), `expected read in ${names.join(",")}`);
      assert.ok(names.includes("store_put"));
      assert.ok(names.includes("store_get"));
      assert.ok(!names.includes("bash"), "bash must be excluded by tools allowlist");
      assert.ok(!names.includes("edit"));
      assert.ok(!names.includes("write"));
    } finally {
      session.dispose();
    }

    faux.setResponses([fauxAssistantMessage("read-only ok")]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
      },
    });
    const result = await agent.run("stay read-only", {
      toolNames: ["read"],
      systemTools: systemTools as never,
      label: "t1",
    });
    assert.equal(result, "read-only ok");
  });
});

test("T2: no tools allowlist defaults include bash", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(cwd, agentDir),
      model: faux.model,
      modelRuntime,
    });
    try {
      assert.ok(session.getActiveToolNames().includes("bash"), "default active tools should include bash");
    } finally {
      session.dispose();
    }
  });
});

test("T3: tools allowlist can include grep/find without createCodingTools custom set", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(cwd, agentDir),
      model: faux.model,
      modelRuntime,
      tools: ["read", "grep", "find"],
    });
    try {
      const names = session.getActiveToolNames();
      assert.ok(names.includes("grep"));
      assert.ok(names.includes("find"));
      assert.ok(names.includes("read"));
      assert.ok(!names.includes("bash"));
    } finally {
      session.dispose();
    }

    faux.setResponses([fauxAssistantMessage("grep-find ok")]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
      },
    });
    assert.equal(await agent.run("use grep/find", { toolNames: ["read", "grep", "find"] }), "grep-find ok");
  });
});

test("T4: excludeTools bash without allowlist removes bash", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    faux.setResponses([fauxAssistantMessage("no bash")]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
      },
    });
    // Verify via SDK session shaped like WorkflowAgent
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(cwd, agentDir),
      model: faux.model,
      modelRuntime,
      excludeTools: ["bash"],
    });
    try {
      assert.ok(!session.getActiveToolNames().includes("bash"));
    } finally {
      session.dispose();
    }
    assert.equal(await agent.run("hello", { disallowedToolNames: ["bash"] }), "no bash");
  });
});

test("T5: systemTools store_put/store_get are callable under restrictive allowlist", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const store = new SharedStore();
    const systemTools = createSharedStoreTools(store);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("store_put", { key: "k", value: "v" }), { type: "text", text: "stored" }], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("stored"),
    ]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
      },
    });
    const result = await agent.run("put shared state", {
      toolNames: ["read"],
      systemTools: systemTools as never,
    });
    assert.equal(result, "stored");
    assert.equal(store.get("k"), "v");
  });
});

test("T5b: structured_output is omitted off and retained on beside SharedStore tools", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const activeToolSets: string[][] = [];
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("session_start", () => activeToolSets.push([...pi.getActiveTools()]));
        },
      ],
    });
    await resourceLoader.reload();

    const store = new SharedStore();
    const systemTools = createSharedStoreTools(store);
    faux.setResponses([
      fauxAssistantMessage("ordinary text"),
      fauxAssistantMessage([fauxToolCall("structured_output", { ok: true })], { stopReason: "toolUse" }),
    ]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
      },
    });
    const schema = Type.Object({ ok: Type.Boolean() });

    const off = await agent.run("text result", {
      schema,
      toolNames: ["read"],
      systemTools: systemTools as never,
    });
    const on = await agent.run("structured result", {
      schema,
      structuredOutputEnabled: true,
      toolNames: ["read"],
      systemTools: systemTools as never,
    });

    assert.equal(off, "ordinary text");
    assert.deepEqual(on, { ok: true });
    assert.equal(activeToolSets.length, 2);
    assert.ok(activeToolSets[0]?.includes("read"));
    assert.ok(activeToolSets[0]?.includes("store_put"));
    assert.ok(!activeToolSets[0]?.includes("structured_output"), "off must not register the schema tool");
    assert.ok(activeToolSets[1]?.includes("structured_output"), "on must retain the schema tool");
    assert.ok(activeToolSets[1]?.includes("store_get"), "structured output must not displace SharedStore tools");
  });
});

test("T6: faux model calling disallowed bash does not execute a real shell command", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const marker = join(cwd, "should-not-exist.txt");
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: `echo pwned > "${marker}"` }), { type: "text", text: "tried bash" }],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("after bash attempt"),
    ]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
      },
    });
    // May throw tool-not-found or return text; either way the file must not exist.
    try {
      await agent.run("try bash", { toolNames: ["read"] });
    } catch {
      // tool failure is acceptable
    }
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false, "disallowed bash must not execute");
  });
});

test("retry policy uses private non-persistent SettingsManagers and replaces stale provider fields", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        retry: {
          enabled: true,
          maxRetries: 9,
          baseDelayMs: 9,
          provider: { timeoutMs: 999, maxRetries: 8, maxRetryDelayMs: 777 },
        },
      }),
    );
    const diskBefore = readFileSync(settingsPath);
    const shared = SettingsManager.create(cwd, agentDir);
    const created: SettingsManager[] = [];
    const factory = () => {
      const manager = SettingsManager.create(cwd, agentDir);
      created.push(manager);
      return manager;
    };
    const host = normalizeHostRetryPolicySnapshot({
      agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
      providerRequest: { maxRetryDelayMs: 30_000 },
    });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const first = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: { model: faux.model, sessionManager: SessionManager.inMemory() },
      hostRetryPolicy: host,
      agentTurnRetry: { enabled: false },
      settingsManagerFactory: factory,
    });
    const second = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: { model: faux.model, sessionManager: SessionManager.inMemory() },
      hostRetryPolicy: host,
      agentTurnRetry: { maxRetries: 2 },
      settingsManagerFactory: factory,
    });

    assert.deepEqual(await Promise.all([first.run("one", { agentTurnRetry: { maxRetries: 1 } }), second.run("two")]), [
      "first",
      "second",
    ]);
    assert.equal(created.length, 2);
    assert.deepEqual(created[0]?.getRetrySettings(), { enabled: false, maxRetries: 1, baseDelayMs: 1000 });
    assert.deepEqual(created[1]?.getRetrySettings(), { enabled: true, maxRetries: 2, baseDelayMs: 1000 });
    assert.deepEqual(created[0]?.getProviderRetrySettings(), {
      timeoutMs: undefined,
      maxRetries: undefined,
      maxRetryDelayMs: 30_000,
    });
    assert.deepEqual(shared.getRetrySettings(), { enabled: true, maxRetries: 9, baseDelayMs: 9 });
    assert.deepEqual(shared.getProviderRetrySettings(), { timeoutMs: 999, maxRetries: 8, maxRetryDelayMs: 777 });
    assert.deepEqual(readFileSync(settingsPath), diskBefore);
  });
});

test("retry policy refuses shared SettingsManager injection", () => {
  const settingsManager = SettingsManager.inMemory();
  const host = normalizeHostRetryPolicySnapshot({
    agentTurn: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
    providerRequest: { maxRetryDelayMs: 30_000 },
  });
  assert.throws(
    () => new WorkflowAgent({ hostRetryPolicy: host, session: { settingsManager } }),
    /shared session\.settingsManager/,
  );
  assert.throws(
    () => new WorkflowAgent({ settingsManagerFactory: () => SettingsManager.inMemory(), session: { settingsManager } }),
    /conflicts/,
  );
});

test("T7/T8: projectTrusted false hides project extension tools; true loads them", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const extDir = join(cwd, ".pi", "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "evil.ts"),
      `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "evil_tool",
    label: "Evil",
    description: "should respect project trust",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "evil" }] };
    },
  });
}
`,
      "utf-8",
    );

    async function activeWithTrust(trusted: boolean): Promise<string[]> {
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
      await resourceLoader.reload({ resolveProjectTrust: async () => trusted });
      const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
        resourceLoader,
        model: faux.model,
        modelRuntime,
      });
      try {
        return session.getAllTools().map((t) => t.name);
      } finally {
        session.dispose();
      }
    }

    const untrusted = await activeWithTrust(false);
    assert.ok(!untrusted.includes("evil_tool"), `untrusted should hide evil_tool; got ${untrusted.join(",")}`);

    const trusted = await activeWithTrust(true);
    assert.ok(trusted.includes("evil_tool"), `trusted should include evil_tool; got ${trusted.join(",")}`);

    // WorkflowAgent projectTrusted plumbing
    faux.setResponses([fauxAssistantMessage("trust false"), fauxAssistantMessage("trust true")]);
    const agentFalse = new WorkflowAgent({
      cwd,
      projectTrusted: false,
      modelRuntime,
      session: { model: faux.model, sessionManager: SessionManager.inMemory() },
    });
    assert.equal(await agentFalse.run("a"), "trust false");
    const agentTrue = new WorkflowAgent({
      cwd,
      projectTrusted: true,
      modelRuntime,
      session: { model: faux.model, sessionManager: SessionManager.inMemory() },
    });
    assert.equal(await agentTrue.run("b"), "trust true");
  });
});

test("T9: session_start-initialized tools still work (lifecycle regression)", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          let initialized = false;
          pi.on("session_start", () => {
            initialized = true;
            const active = pi.getActiveTools();
            if (!active.includes("session_ready_tool")) pi.setActiveTools([...active, "session_ready_tool"]);
          });
          pi.registerTool({
            name: "session_ready_tool",
            label: "Session Ready Tool",
            description: "ready",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: initialized ? "session-ready" : "not-initialized" }],
                details: { initialized },
                isError: !initialized,
              };
            },
          });
        },
      ],
    });
    await resourceLoader.reload();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session_ready_tool", {}), { type: "text", text: "tool returned session-ready" }],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("tool returned session-ready"),
    ]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        resourceLoader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
      },
    });
    assert.equal(await agent.run("check lifecycle"), "tool returned session-ready");
  });
});

test("T10: wrapResourceLoader filters workflow + optional extra paths", () => {
  const workflowExtension = {
    path: "extensions/workflow.ts",
    resolvedPath: "/tmp/project/extensions/workflow.ts",
  } as any;
  const trellisExtension = {
    path: ".pi/extensions/trellis/index.ts",
    resolvedPath: "/tmp/project/.pi/extensions/trellis/index.ts",
  } as any;
  const safeExtension = {
    path: "extensions/safe.ts",
    resolvedPath: "/tmp/project/extensions/safe.ts",
  } as any;
  const baseResult = {
    extensions: [workflowExtension, trellisExtension, safeExtension],
    errors: [],
    runtime: {},
  } as any;
  const baseLoader = {
    getExtensions: () => baseResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as any;

  const onlyWorkflow = wrapResourceLoaderForWorkflowSubagents(baseLoader).getExtensions();
  assert.deepEqual(
    onlyWorkflow.extensions.map((e: any) => e.path),
    [".pi/extensions/trellis/index.ts", "extensions/safe.ts"],
  );

  const withTrellis = wrapResourceLoaderForWorkflowSubagents(baseLoader, {
    extensionPathFilters: [
      (p) =>
        p.replace(/\\/g, "/").includes("/.pi/extensions/trellis/") ||
        p.replace(/\\/g, "/").includes("extensions/trellis"),
    ],
  }).getExtensions();
  assert.deepEqual(
    withTrellis.extensions.map((e: any) => e.path),
    ["extensions/safe.ts"],
  );
});

test("T11: resume hash differs when call-site isolation is worktree vs absent", async () => {
  // Mirror hashAgentCall identity shape (exported indirectly via journal behavior).
  const base = {
    prompt: "p",
    model: null,
    tier: null,
    phase: null,
    agentType: null,
    agentDef: null,
    schema: null,
  };
  const without = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const withIso = createHash("sha256")
    .update(JSON.stringify({ ...base, isolation: "worktree" }))
    .digest("hex");
  assert.notEqual(without, withIso);

  // Behavioral check through runWorkflow journals.
  const { runWorkflow } = await import("../src/workflow.js");
  const journalA: Array<{ hash: string }> = [];
  const journalB: Array<{ hash: string }> = [];
  const agent = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(`export const meta = { name: 'h1', description: 'h' }; return await agent('p');`, {
    agent,
    persistLogs: false,
    onAgentJournal: (e) => journalA.push(e),
  });
  await runWorkflow(
    `export const meta = { name: 'h2', description: 'h' }; return await agent('p', { isolation: 'worktree' });`,
    {
      agent,
      persistLogs: false,
      onAgentJournal: (e) => journalB.push(e),
    },
  );
  assert.notEqual(journalA[0]?.hash, journalB[0]?.hash);
});

test("T12: old journal shape without isolation still replays", async () => {
  const { runWorkflow } = await import("../src/workflow.js");
  const journal: Array<{ index: number; hash: string; result: unknown }> = [];
  const counting = { n: 0 };
  const agent = {
    async run(prompt: string) {
      counting.n++;
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'resume_old', description: 'r' }; return await agent('same');`;
  await runWorkflow(script, {
    agent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(counting.n, 1);
  counting.n = 0;
  await runWorkflow(script, {
    agent,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(counting.n, 0, "unchanged non-isolation call should still cache-hit");
});

test("T13/T14: context loader no-op by default; prefix changes prompt and resume hash", async () => {
  const { runWorkflow } = await import("../src/workflow.js");
  const seen: string[] = [];
  const agent = {
    async run(prompt: string) {
      seen.push(prompt);
      return "ok";
    },
  };
  await runWorkflow(`export const meta = { name: 'ctx0', description: 'c' }; return await agent('TASK');`, {
    agent,
    persistLogs: false,
  });
  assert.equal(seen[0], "TASK");

  const journal: Array<{ hash: string }> = [];
  seen.length = 0;
  await runWorkflow(`export const meta = { name: 'ctx1', description: 'c' }; return await agent('TASK');`, {
    agent,
    persistLogs: false,
    contextLoader: async () => ({ promptPrefix: "## PREFIX\ncontext" }),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.ok(seen[0]?.includes("## PREFIX"));
  assert.ok(seen[0]?.includes("TASK"));

  const journal2: Array<{ hash: string }> = [];
  await runWorkflow(`export const meta = { name: 'ctx2', description: 'c' }; return await agent('TASK');`, {
    agent: {
      async run() {
        return "ok";
      },
    },
    persistLogs: false,
    onAgentJournal: (e) => journal2.push(e),
  });
  assert.notEqual(journal[0]?.hash, journal2[0]?.hash, "prefix must change resume hash");
});

test("resume hash includes canonical context instructions and environment", async () => {
  const { runWorkflow } = await import("../src/workflow.js");
  const script = `export const meta = { name: 'ctx_hash', description: 'c' }; return await agent('TASK');`;
  const runWithContext = async (instructions: string, env: Record<string, string>) => {
    const journal: Array<{ hash: string }> = [];
    await runWorkflow(script, {
      agent: { run: async () => "ok" },
      persistLogs: false,
      contextLoader: async () => ({ instructions, env }),
      onAgentJournal: (entry) => journal.push(entry),
    });
    return journal[0]?.hash;
  };

  const original = await runWithContext("ROLE A", { B: "2", A: "1" });
  const reordered = await runWithContext("ROLE A", { A: "1", B: "2" });
  const changedInstructions = await runWithContext("ROLE B", { A: "1", B: "2" });
  const changedEnv = await runWithContext("ROLE A", { A: "1", B: "3" });
  assert.equal(original, reordered, "environment key order must not affect resume identity");
  assert.notEqual(original, changedInstructions);
  assert.notEqual(original, changedEnv);
});

test("filterShadowingBuiltinCustomTools drops coding builtins but keeps extras", () => {
  assert.deepEqual(
    filterShadowingBuiltinCustomTools([
      { name: "read" },
      { name: "bash" },
      { name: "web_search" },
      { name: "store_put" },
    ]).map((t) => t.name),
    ["web_search", "store_put"],
  );
});

test("T25: historical createCodingTools(cwd) extras do not shadow session built-ins under worktree cwd", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const { createCodingTools } = await import("@earendil-works/pi-coding-agent");
    const worktreeCwd = mkdtempSync(join(tmpdir(), "pi-dw-worktree-cwd-"));
    try {
      const hostTools = createCodingTools(cwd);
      // Legacy callers passed host-cwd coding tools; filter keeps only non-builtins.
      assert.deepEqual(
        filterShadowingBuiltinCustomTools(hostTools as never).map((t: { name: string }) => t.name),
        [],
      );

      faux.setResponses([fauxAssistantMessage("worktree-ok")]);
      const agent = new WorkflowAgent({
        cwd,
        tools: createCodingTools(cwd) as never,
        modelRuntime,
        session: {
          model: faux.model,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.create(worktreeCwd, agentDir),
        },
      });
      assert.equal(await agent.run("in worktree", { cwd: worktreeCwd }), "worktree-ok");
    } finally {
      rmSync(worktreeCwd, { recursive: true, force: true });
    }
  });
});

test("T26: systemTools survive denylist excludeTools", async () => {
  await withAgentSession(async ({ cwd, agentDir, faux, modelRuntime }) => {
    const store = new SharedStore();
    const systemTools = createSharedStoreTools(store);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("store_put", { key: "keep", value: "yes" }), { type: "text", text: "ok" }], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("ok"),
    ]);
    const agent = new WorkflowAgent({
      cwd,
      modelRuntime,
      session: {
        model: faux.model,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.create(cwd, agentDir),
      },
    });
    const result = await agent.run("put despite deny", {
      toolNames: ["read"],
      disallowedToolNames: ["store_put", "bash"],
      systemTools: systemTools as never,
    });
    assert.equal(result, "ok");
    assert.equal(store.get("keep"), "yes", "store_put must bypass denylist");
  });
});
