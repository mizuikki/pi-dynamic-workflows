import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import workflowExtension from "../extensions/workflow.js";
import { isKnownTrellisChild, WorkflowAgent } from "../src/agent.js";
import {
  enableWorkflowMainPrompt,
  formatWorkflowMainPromptDiagnostic,
  getWorkflowMainPromptSettingsPath,
  inspectWorkflowMainPrompt,
  isWorkflowMainPromptEnabled,
  MAX_WORKFLOW_MAIN_BYTES,
  loadWorkflowMainPrompt as readWorkflowMainPromptFile,
  registerWorkflowMainPromptCommand,
  WORKFLOW_MAIN_MARKER,
  WORKFLOW_MAIN_RELATIVE_PATH,
} from "../src/main-agent-prompt.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createExplicitFauxModels, createFauxModelRegistry } from "./helpers/faux-models.js";

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-"));
  mkdirSync(join(cwd, ".pi"));
  return cwd;
}

function promptPath(cwd: string): string {
  return join(cwd, WORKFLOW_MAIN_RELATIVE_PATH);
}

function cleanup(cwd: string): void {
  rmSync(cwd, { recursive: true, force: true });
}

const AUTHORIZED_ACCESS = { projectTrusted: true, allowHeadless: true } as const;

function loadWorkflowMainPrompt(cwd: string, systemPrompt: string) {
  return readWorkflowMainPromptFile(cwd, systemPrompt, AUTHORIZED_ACCESS);
}

test("does not read the project prompt before explicit access is supplied", async () => {
  const cwd = project();
  try {
    writeFileSync(promptPath(cwd), "must remain unread");
    const result = await readWorkflowMainPromptFile(cwd, "base");
    assert.equal(result.systemPrompt, "base");
    assert.deepEqual(result.diagnostic, {
      path: WORKFLOW_MAIN_RELATIVE_PATH,
      source: "project",
      state: "skipped",
      reason: "authorization-required",
      bytes: 0,
      characters: 0,
      sha256: "-",
    });
  } finally {
    cleanup(cwd);
  }
});

test("loads the trusted project prompt and preserves the current system prompt", async () => {
  const cwd = project();
  try {
    const content = "Use the repository's implementation conventions.";
    writeFileSync(promptPath(cwd), content);
    const result = await loadWorkflowMainPrompt(cwd, "Earlier extension changes");

    assert.equal(result.systemPrompt, `Earlier extension changes\n\n${WORKFLOW_MAIN_MARKER}\n${content}`);
    assert.deepEqual(result.diagnostic, {
      path: WORKFLOW_MAIN_RELATIVE_PATH,
      source: "project",
      state: "injected",
      reason: "loaded",
      bytes: Buffer.byteLength(content),
      characters: content.length,
      sha256: "36964a397d8c",
    });
  } finally {
    cleanup(cwd);
  }
});

test("is live per turn and deduplicates marker, exact content, and APPEND_SYSTEM content", async () => {
  const cwd = project();
  try {
    const first = "First live prompt";
    const second = "Second live prompt";
    writeFileSync(promptPath(cwd), first);
    const loaded = await loadWorkflowMainPrompt(cwd, "base");
    assert.match(loaded.systemPrompt, new RegExp(`${WORKFLOW_MAIN_MARKER}\\n${first}`));

    writeFileSync(promptPath(cwd), second);
    const rewritten = await loadWorkflowMainPrompt(cwd, "base");
    assert.match(rewritten.systemPrompt, new RegExp(`${WORKFLOW_MAIN_MARKER}\\n${second}`));
    assert.doesNotMatch(rewritten.systemPrompt, new RegExp(first));

    const marked = await loadWorkflowMainPrompt(cwd, `${WORKFLOW_MAIN_MARKER}\n${first}`);
    assert.equal(marked.systemPrompt, `${WORKFLOW_MAIN_MARKER}\n${first}`);
    assert.equal(marked.diagnostic.reason, "marker-present");

    const appendSystem = `${first}\n\nbase APPEND_SYSTEM.md content`;
    writeFileSync(promptPath(cwd), appendSystem);
    const duplicate = await loadWorkflowMainPrompt(cwd, `base\n\n${appendSystem}`);
    assert.equal(duplicate.systemPrompt, `base\n\n${appendSystem}`);
    assert.equal(duplicate.diagnostic.reason, "content-present");

    const inspected = await inspectWorkflowMainPrompt(cwd, AUTHORIZED_ACCESS);
    assert.equal(inspected.bytes, Buffer.byteLength(appendSystem));
    assert.notEqual(inspected.sha256, "-");
    assert.equal(inspected.reason, "loaded");
  } finally {
    cleanup(cwd);
  }
});

test("prompt opt-in is exact-project scoped with no global or parent inheritance", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-scope-home-"));
  const parent = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-scope-parent-"));
  const child = join(parent, "child");
  const sibling = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-scope-sibling-"));
  mkdirSync(child, { recursive: true });
  try {
    await withFakeHomeAsync(home, async () => {
      enableWorkflowMainPrompt(parent);
      assert.equal(isWorkflowMainPromptEnabled(parent), true);
      assert.equal(isWorkflowMainPromptEnabled(child), false);
      assert.equal(isWorkflowMainPromptEnabled(sibling), false);
      writeFileSync(join(home, ".pi", "workflows", "settings.json"), JSON.stringify({ mainPromptEnabled: true }));
      assert.equal(isWorkflowMainPromptEnabled(sibling), false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    cleanup(parent);
    cleanup(sibling);
  }
});

test("ignores empty and whitespace-only files with bounded metadata", async () => {
  const cwd = project();
  try {
    writeFileSync(promptPath(cwd), "");
    const empty = await loadWorkflowMainPrompt(cwd, "base");
    assert.equal(empty.systemPrompt, "base");
    assert.equal(empty.diagnostic.reason, "empty");
    assert.equal(empty.diagnostic.bytes, 0);

    writeFileSync(promptPath(cwd), " \n\t");
    const whitespace = await loadWorkflowMainPrompt(cwd, "base");
    assert.equal(whitespace.systemPrompt, "base");
    assert.equal(whitespace.diagnostic.reason, "whitespace-only");
    assert.equal(whitespace.diagnostic.bytes, 3);
  } finally {
    cleanup(cwd);
  }
});

test("fails closed for missing, oversized, invalid UTF-8, symlink, and directory resources", async () => {
  const cwd = project();
  try {
    rmSync(promptPath(cwd), { force: true });
    assert.equal((await loadWorkflowMainPrompt(cwd, "base")).diagnostic.reason, "missing");

    writeFileSync(promptPath(cwd), Buffer.alloc(MAX_WORKFLOW_MAIN_BYTES + 1, 0x61));
    const oversized = await loadWorkflowMainPrompt(cwd, "base");
    assert.equal(oversized.diagnostic.reason, "oversized");
    assert.equal(oversized.diagnostic.bytes, MAX_WORKFLOW_MAIN_BYTES + 1);

    writeFileSync(promptPath(cwd), Buffer.from([0xc3, 0x28]));
    const invalid = await loadWorkflowMainPrompt(cwd, "base");
    assert.equal(invalid.diagnostic.reason, "invalid-utf8");
    assert.equal(invalid.systemPrompt, "base");

    rmSync(promptPath(cwd));
    writeFileSync(join(cwd, "target.md"), "do not load");
    symlinkSync(join(cwd, "target.md"), promptPath(cwd));
    assert.equal((await loadWorkflowMainPrompt(cwd, "base")).diagnostic.reason, "symlink");

    rmSync(promptPath(cwd));
    mkdirSync(promptPath(cwd));
    assert.equal((await loadWorkflowMainPrompt(cwd, "base")).diagnostic.reason, "directory");
  } finally {
    cleanup(cwd);
  }
});

test("accepts exactly the 64 KiB boundary and rejects read errors without raw errors", async () => {
  const cwd = project();
  try {
    const content = "a".repeat(MAX_WORKFLOW_MAIN_BYTES);
    writeFileSync(promptPath(cwd), content);
    const boundary = await loadWorkflowMainPrompt(cwd, "base");
    assert.equal(boundary.diagnostic.state, "injected");
    assert.equal(boundary.diagnostic.bytes, MAX_WORKFLOW_MAIN_BYTES);

    const missingCwd = join(cwd, "removed");
    const result = await loadWorkflowMainPrompt(missingCwd, "base");
    const rendered = formatWorkflowMainPromptDiagnostic(result.diagnostic);
    assert.equal(result.diagnostic.reason, "missing");
    assert.doesNotMatch(rendered, /ENOENT|removed|base/);
    assert.match(rendered, /path=\.pi\/WORKFLOW_MAIN\.md/);
  } finally {
    cleanup(cwd);
  }
});

test("prompt command requires opt-in, confirms writes, and reports metadata only after authorization", async () => {
  const cwd = project();
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-command-home-"));
  const commands: Array<{ name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }> = [];
  const notifications: string[] = [];
  const sent: unknown[] = [];
  let confirmed = false;
  let flagValue: boolean | undefined;
  const pi = {
    getCommands: () => [],
    getFlag: () => flagValue,
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      commands.push({ name, handler: command.handler });
    },
    sendMessage: (message: unknown) => sent.push(message),
  } as unknown as ExtensionAPI;

  const originalTrellisChild = process.env.TRELLIS_SUBAGENT_CHILD;
  const originalDynamicChild = process.env.PI_DYNAMIC_WORKFLOWS_CHILD;
  try {
    await withFakeHomeAsync(home, async () => {
      writeFileSync(promptPath(cwd), "secret prompt content");
      registerWorkflowMainPromptCommand(pi);
      assert.equal(commands.length, 1);
      const command = commands[0];
      assert.ok(command);

      const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        getSystemPrompt: () => {
          throw new Error("status must not consult the current system prompt");
        },
        ui: {
          confirm: async () => confirmed,
          notify: (message: string) => notifications.push(message),
        },
      } as unknown as ExtensionCommandContext;
      await command.handler("status", ctx);
      assert.match(notifications.at(-1) ?? "", /reason=opt-in-disabled/);
      assert.equal(sent.length, 0);

      const headless = { ...ctx, hasUI: false } as unknown as ExtensionCommandContext;
      await command.handler("enable", headless);
      assert.match(notifications.at(-1) ?? "", /requires interactive UI/);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false);

      confirmed = false;
      await command.handler("enable", ctx);
      assert.match(notifications.at(-1) ?? "", /remains disabled/);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false);

      await command.handler("enable", { ...ctx, isProjectTrusted: () => false });
      assert.match(notifications.at(-1) ?? "", /requires a trusted project/);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false);

      confirmed = true;
      await command.handler("enable", ctx);
      assert.equal(JSON.parse(readFileSync(getWorkflowMainPromptSettingsPath(cwd), "utf8")).mainPromptEnabled, true);

      await command.handler("status", ctx);
      assert.match(notifications.at(-1) ?? "", /state=injected/);
      assert.match(notifications.at(-1) ?? "", /bytes=21/);
      assert.match(notifications.at(-1) ?? "", /sha256=/);
      assert.doesNotMatch(notifications.at(-1) ?? "", /secret prompt content/);

      writeFileSync(getWorkflowMainPromptSettingsPath(cwd), "not-json");
      await command.handler("status", ctx);
      assert.match(notifications.at(-1) ?? "", /reason=malformed-opt-in/);

      writeFileSync(getWorkflowMainPromptSettingsPath(cwd), JSON.stringify({ mainPromptEnabled: true }));
      await command.handler("disable", ctx);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false);

      await command.handler("", ctx);
      assert.match(notifications.at(-1) ?? "", /Usage: \/workflows-prompt enable\|disable\|status/);

      const untrusted = { ...ctx, isProjectTrusted: () => false } as unknown as ExtensionCommandContext;
      await command.handler("status", untrusted);
      assert.match(notifications.at(-1) ?? "", /reason=untrusted-project/);

      const brokenTrust = {
        ...ctx,
        isProjectTrusted: () => {
          throw new Error("trust provider failed");
        },
      } as unknown as ExtensionCommandContext;
      await command.handler("status", brokenTrust);
      assert.match(notifications.at(-1) ?? "", /reason=untrusted-project/);

      process.env.PI_DYNAMIC_WORKFLOWS_CHILD = "1";
      await command.handler("status", ctx);
      assert.match(notifications.at(-1) ?? "", /reason=child-process/);

      delete process.env.PI_DYNAMIC_WORKFLOWS_CHILD;
      flagValue = true;
      await command.handler("status", ctx);
      assert.match(notifications.at(-1) ?? "", /state=injected/);
      assert.equal(existsSync(getWorkflowMainPromptSettingsPath(cwd)), false, "flag must not persist authorization");
    });
  } finally {
    if (originalTrellisChild === undefined) delete process.env.TRELLIS_SUBAGENT_CHILD;
    else process.env.TRELLIS_SUBAGENT_CHILD = originalTrellisChild;
    if (originalDynamicChild === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_CHILD;
    else process.env.PI_DYNAMIC_WORKFLOWS_CHILD = originalDynamicChild;
    rmSync(home, { recursive: true, force: true });
    cleanup(cwd);
  }
});

test("only explicit child markers suppress host prompt loading", () => {
  assert.equal(isKnownTrellisChild({ TRELLIS_SUBAGENT_CHILD: "1" }), true);
  assert.equal(isKnownTrellisChild({ PI_DYNAMIC_WORKFLOWS_CHILD: "1" }), true);
  assert.equal(isKnownTrellisChild({ TRELLIS_CONTEXT_ID: "pi_session" }), false);
  assert.equal(isKnownTrellisChild({ TRELLIS_SUBAGENT_CHILD: "0" }), false);
});

test("duplicate command registration is ignored", () => {
  const commands: string[] = [];
  const pi = {
    getCommands: () => [{ name: "workflows-prompt" }],
    registerCommand: (name: string) => commands.push(name),
  } as unknown as ExtensionAPI;
  registerWorkflowMainPromptCommand(pi);
  assert.deepEqual(commands, []);
});

test("real Pi host turns inject, chain, and re-read the project prompt once per turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-e2e-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-e2e-cwd-"));
  const extensionPath = resolve("extensions/workflow.ts");
  const capturedPrompts: string[] = [];
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "main-prompt-e2e", name: "Main Prompt E2E" }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "shared append instructions");
    writeFileSync(join(cwd, ".pi", "WORKFLOW_MAIN.md"), "host prompt one");
    faux.setResponses([
      (context) => {
        capturedPrompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("first");
      },
      (context) => {
        capturedPrompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("second");
      },
      (context) => {
        capturedPrompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("third");
      },
    ]);

    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        const agentDir = join(home, ".pi", "agent");
        mkdirSync(agentDir, { recursive: true });
        enableWorkflowMainPrompt(cwd);
        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          additionalExtensionPaths: [extensionPath],
          extensionFactories: [
            (pi) => {
              pi.on("before_agent_start", (event) => ({
                systemPrompt: `${event.systemPrompt}\n\nchain handler`,
              }));
            },
          ],
        });
        await resourceLoader.reload();
        const created = await createAgentSession({
          cwd,
          agentDir,
          model: faux.model,
          modelRegistry: createFauxModelRegistry(faux),
          sessionManager: SessionManager.inMemory(),
          settingsManager,
          resourceLoader,
        });
        session = created.session;
        await session.bindExtensions({
          commandContextActions: {
            waitForIdle: () => session?.agent.waitForIdle() ?? Promise.resolve(),
            newSession: async () => ({ cancelled: true }),
            fork: async () => ({ cancelled: true }),
            navigateTree: async () => ({ cancelled: true }),
            switchSession: async () => ({ cancelled: true }),
            reload: async () => {
              await session?.reload();
            },
          },
          onError: (error) => {
            throw new Error(`extension error: ${error.error}`);
          },
        });

        await session.prompt("first turn");
        writeFileSync(join(cwd, ".pi", "WORKFLOW_MAIN.md"), "host prompt two");
        await session.prompt("second turn");
        writeFileSync(join(cwd, ".pi", "WORKFLOW_MAIN.md"), "host prompt three");
        await session.prompt("third turn");
      } finally {
        process.chdir(originalCwd);
      }
    });

    assert.equal(capturedPrompts.length, 3);
    assert.equal((capturedPrompts[0]?.match(/pi-dynamic-workflows:workflow-main/g) ?? []).length, 1);
    assert.equal((capturedPrompts[1]?.match(/pi-dynamic-workflows:workflow-main/g) ?? []).length, 1);
    assert.equal((capturedPrompts[2]?.match(/pi-dynamic-workflows:workflow-main/g) ?? []).length, 1);
    assert.match(capturedPrompts[0] ?? "", /host prompt one/);
    assert.match(capturedPrompts[0] ?? "", /shared append instructions/);
    assert.match(capturedPrompts[0] ?? "", /chain handler/);
    assert.match(capturedPrompts[1] ?? "", /host prompt two/);
    assert.doesNotMatch(capturedPrompts[1] ?? "", /host prompt one/);
    assert.match(capturedPrompts[2] ?? "", /host prompt three/);
    assert.doesNotMatch(capturedPrompts[2] ?? "", /host prompt two/);
  } finally {
    session?.dispose();
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent child sessions filter the host extension before it can inject", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-child-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-child-cwd-"));
  const extensionPath = resolve("extensions/workflow.ts");
  const capturedPrompts: string[] = [];
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "main-prompt-child", name: "Main Prompt Child" }],
  });

  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "WORKFLOW_MAIN.md"), "host prompt must stay out of child");
    faux.setResponses([
      (context) => {
        capturedPrompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("child");
      },
    ]);

    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [extensionPath],
      });
      const agent = new WorkflowAgent({
        cwd,
        projectTrusted: true,
        modelRegistry: createFauxModelRegistry(faux),
        session: {
          model: faux.model,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager,
        },
      });

      assert.equal(await agent.run("child turn"), "child");
    });

    assert.equal(capturedPrompts.length, 1);
    assert.doesNotMatch(capturedPrompts[0] ?? "", /host prompt must stay out of child/);
    assert.equal((capturedPrompts[0]?.match(/pi-dynamic-workflows:workflow-main/g) ?? []).length, 0);
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent custom inline loaders isolate the host policy and preserve APPEND_SYSTEM", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-inline-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-main-prompt-inline-cwd-"));
  const capturedPrompts: string[] = [];
  const faux = createExplicitFauxModels({
    provider: "deepseek",
    models: [{ id: "main-prompt-inline", name: "Main Prompt Inline" }],
  });

  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "append instructions must remain");
    writeFileSync(promptPath(cwd), "inline host prompt must stay out");
    faux.setResponses([
      (context) => {
        capturedPrompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("inline child");
      },
    ]);

    await withFakeHomeAsync(home, async () => {
      const originalCwd = process.cwd();
      process.chdir(cwd);
      try {
        enableWorkflowMainPrompt(cwd);
        const agentDir = join(home, ".pi", "agent");
        mkdirSync(agentDir, { recursive: true });
        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          extensionFactories: [workflowExtension],
        });
        await resourceLoader.reload();
        assert.match(resourceLoader.getExtensions().extensions[0]?.path ?? "", /^<inline:/);
        const agent = new WorkflowAgent({
          cwd,
          projectTrusted: true,
          modelRegistry: createFauxModelRegistry(faux),
          session: {
            model: faux.model,
            resourceLoader,
            sessionManager: SessionManager.inMemory(),
            settingsManager,
          },
        });
        assert.equal(await agent.run("inline child turn"), "inline child");
      } finally {
        process.chdir(originalCwd);
      }
    });

    assert.equal(capturedPrompts.length, 1);
    assert.doesNotMatch(capturedPrompts[0] ?? "", /inline host prompt must stay out/);
    assert.match(capturedPrompts[0] ?? "", /append instructions must remain/);
    assert.equal((capturedPrompts[0]?.match(/pi-dynamic-workflows:workflow-main/g) ?? []).length, 0);
  } finally {
    faux.dispose();
    rmSync(home, { recursive: true, force: true });
    cleanup(cwd);
  }
});
