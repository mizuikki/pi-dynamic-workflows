import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  commandAlreadySetsEnv,
  createSubagentEnvInterceptorFactory,
  createTrellisContextLoader,
  mergeSubagentEnv,
  prependEnvExports,
  resolveTrellisContextKey,
  WorkflowAgent,
} from "../src/index.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels, createFauxRuntimeBundle } from "./helpers/faux-models.js";

test("prependEnvExports injects export and skips when already present", () => {
  const env = { TRELLIS_CONTEXT_ID: "pi_abc" };
  assert.equal(commandAlreadySetsEnv("echo hi", env), false);
  assert.equal(commandAlreadySetsEnv("export TRELLIS_CONTEXT_ID=x; echo hi", env), true);
  assert.equal(commandAlreadySetsEnv("TRELLIS_CONTEXT_ID=x echo hi", env), true);
  const rewritten = prependEnvExports("echo hi", env);
  assert.match(rewritten, /^export TRELLIS_CONTEXT_ID='pi_abc'; echo hi$/);
  assert.equal(
    prependEnvExports("export TRELLIS_CONTEXT_ID='pi_abc'; echo hi", env),
    "export TRELLIS_CONTEXT_ID='pi_abc'; echo hi",
  );
});

test("mergeSubagentEnv later wins", () => {
  assert.deepEqual(mergeSubagentEnv({ A: "1" }, { A: "2", B: "3" }), { A: "2", B: "3" });
});

test("prependEnvExports preserves existing keys and injects each missing valid key", () => {
  assert.equal(
    prependEnvExports("export A='existing'; echo ok", { A: "loader", B: "missing", "BAD-KEY": "ignored" }),
    "export B='missing'; export A='existing'; echo ok",
  );
});

test("createSubagentEnvInterceptorFactory rewrites bash command via tool_call", () => {
  const factory = createSubagentEnvInterceptorFactory({ TRELLIS_CONTEXT_ID: "key-a" });
  let handler: ((event: { toolName: string; input: { command?: string } }) => void) | undefined;
  const pi = {
    on(event: string, h: typeof handler) {
      if (event === "tool_call") handler = h;
    },
  };
  factory(pi as never);
  assert.equal(typeof handler, "function");
  const rewrite = handler as (event: { toolName: string; input: { command?: string } }) => void;
  const ev = { toolName: "bash" as const, input: { command: "printenv TRELLIS_CONTEXT_ID" } };
  rewrite(ev);
  assert.match(String(ev.input.command), /export TRELLIS_CONTEXT_ID='key-a'; printenv TRELLIS_CONTEXT_ID/);

  const ev2 = {
    toolName: "bash" as const,
    input: { command: "export TRELLIS_CONTEXT_ID='already'; printenv" },
  };
  rewrite(ev2);
  assert.equal(ev2.input.command, "export TRELLIS_CONTEXT_ID='already'; printenv");
});

test("loader returns env.TRELLIS_CONTEXT_ID from sessionId", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-env-loader-"));
  try {
    mkdirSync(join(cwd, ".trellis", "tasks", "t1"), { recursive: true });
    writeFileSync(join(cwd, ".trellis", "tasks", "t1", "prd.md"), "p", "utf-8");
    const sessions = join(cwd, ".trellis", ".runtime", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "pi_sess1.json"), JSON.stringify({ current_task: ".trellis/tasks/t1" }), "utf-8");
    const loader = createTrellisContextLoader({ enabled: "on", resolveTaskPyCurrent: () => null });
    const ctx = await loader({ cwd, prompt: "work", sessionId: "sess1", agentType: "trellis-implement" });
    assert.equal(ctx?.env?.TRELLIS_CONTEXT_ID, "pi_sess1");
    assert.ok(ctx?.promptPrefix?.includes("Trellis Task Context"));
    assert.equal(resolveTrellisContextKey(cwd, "sess1"), "pi_sess1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parallel agents with different env keys do not cross-contaminate interceptor closures", () => {
  const f1 = createSubagentEnvInterceptorFactory({ TRELLIS_CONTEXT_ID: "key-1" });
  const f2 = createSubagentEnvInterceptorFactory({ TRELLIS_CONTEXT_ID: "key-2" });
  const handlers: Array<(e: { toolName: string; input: { command?: string } }) => void> = [];
  for (const f of [f1, f2]) {
    f({
      on(_ev: string, h: (e: { toolName: string; input: { command?: string } }) => void) {
        handlers.push(h);
      },
    } as never);
  }
  assert.equal(handlers.length, 2);
  const e1 = { toolName: "bash", input: { command: "echo 1" } };
  const e2 = { toolName: "bash", input: { command: "echo 2" } };
  handlers[0]?.(e1);
  handlers[1]?.(e2);
  assert.match(String(e1.input.command), /key-1/);
  assert.match(String(e2.input.command), /key-2/);
  assert.ok(!String(e1.input.command).includes("key-2"));
  assert.ok(!String(e2.input.command).includes("key-1"));
});

test("WorkflowAgent applies env interceptor so bash sees TRELLIS_CONTEXT_ID", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-bash-env-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-bash-env-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "bash-env", name: "Bash Env", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      // Capture the command the bash tool actually receives via a spy-friendly path:
      // have the model call bash with printenv; the interceptor should prepend export.
      // We observe success if bash result contains our key. Use a command that echoes
      // the env after export injection: `printenv TRELLIS_CONTEXT_ID` — but bash tool
      // runs for real. Safer: use `echo $TRELLIS_CONTEXT_ID` after export prefix.
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("bash", { command: "printf '%s' \"$TRELLIS_CONTEXT_ID\"" }), { type: "text", text: "ran" }],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
      const { modelRuntime, modelRegistry } = await createFauxRuntimeBundle(faux);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        modelRuntime,
        session: {
          model: faux.model,
          modelRuntime,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });
      const historySnapshots: Array<Array<{ role?: string; kind?: string; toolName?: string; text?: string }>> = [];
      const result = await agent.run("Print the trellis context id via bash.", {
        label: "env-bash",
        env: { TRELLIS_CONTEXT_ID: "pi_test_key_42" },
        onHistory: (history) => {
          historySnapshots.push(history as Array<{ role?: string; kind?: string; toolName?: string; text?: string }>);
        },
      });
      assert.equal(typeof result, "string");
      assert.equal(result, "done");
      assert.equal(faux.getPendingResponseCount(), 0);
      const flat = historySnapshots.flat();
      const bashResult = flat.find((entry) => entry.toolName === "bash" && entry.kind === "toolResult");
      assert.ok(bashResult, `expected bash toolResult in history; got ${JSON.stringify(flat)}`);
      assert.equal(bashResult?.text?.trim(), "pi_test_key_42");
    });
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
