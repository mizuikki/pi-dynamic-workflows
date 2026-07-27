import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createEffortState,
  createTrellisContextLoader,
  createTrellisSubagentTool,
  createWorkflowStorage,
  createWorkflowTool,
  hasRegisteredTrellisSubagentTool,
  hasSupportedTrellisProject,
  hasTrellisProject,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  isKnownTrellisChild,
  isWorkflowMainPromptEnabled,
  listAvailableModelSpecsAsync,
  loadWorkflowMainPrompt,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowMainPromptCommand,
  registerWorkflowMainPromptFlag,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  shouldEnableTrellisAdapter,
  shouldRegisterTrellisSubagentTool,
  trellisExtensionPathFilter,
  WorkflowAgent,
  WorkflowManager,
} from "../src/index.js";
import { createPluginModelRuntime } from "../src/model-runtime.js";

export default function extension(pi: ExtensionAPI) {
  if (capabilityVersion(pi, "extensionSdkApiVersion") !== 1) {
    throw new Error("Pi host is incompatible: requires extension SDK API version 1");
  }
  if (capabilityVersion(pi, "modelRuntimeApiVersion") !== 1) {
    throw new Error("Pi host is incompatible: requires model runtime API version 1");
  }

  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  // Optional Trellis adapter: read-only context injection + optional host tool
  // when the native Trellis extension is absent. Never owns create/start/archive
  // or phase management.
  const trellisCompatible = hasSupportedTrellisProject(cwd);
  if (hasTrellisProject(cwd) && !trellisCompatible) {
    console.warn("[trellis-adapter] disabled: requires Trellis project version 1.0.1");
  }
  const trellisEnabled = trellisCompatible && shouldEnableTrellisAdapter(cwd, settings.trellisAdapter);
  const trellisContextLoader = trellisEnabled
    ? createTrellisContextLoader({
        enabled: settings.trellisAdapter?.enabled ?? "auto",
        autoPrependActiveTaskLine: settings.trellisAdapter?.autoPrependActiveTaskLine,
        registerSubagentTool: settings.trellisAdapter?.registerSubagentTool,
      })
    : undefined;
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
    ...(trellisEnabled
      ? {
          contextLoader: trellisContextLoader,
          extensionPathFilters: [trellisExtensionPathFilter],
        }
      : {}),
  });

  let workflowTool = createWorkflowTool({ cwd, manager, storage });
  pi.registerTool(workflowTool);

  pi.on("before_agent_start", async (event, ctx) => {
    if (isKnownTrellisChild(process.env)) return;
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted() === true;
    } catch {
      // A broken trust provider must not make project instructions executable.
    }
    if (!trusted) return;

    const explicitlyEnabled = pi.getFlag?.("workflow-main-prompt") === true;
    if (!explicitlyEnabled && !isWorkflowMainPromptEnabled(ctx.cwd)) return;

    const result = await loadWorkflowMainPrompt(ctx.cwd, event.systemPrompt, {
      projectTrusted: true,
      allowHeadless: explicitlyEnabled,
    });

    return result.systemPrompt === event.systemPrompt ? undefined : { systemPrompt: result.systemPrompt };
  });

  // Optional trellis_subagent: register only when adapter wants it, native
  // extension files are absent (auto), and no tool with that name exists yet.
  // Decision is deferred to session_start when getAllTools is reliably available.
  let trellisSubagentRegistered = false;
  let hostSessionId: string | undefined;
  let hostProjectTrusted: boolean | undefined;
  let hostThinkingLevel: string | undefined;

  const ensureWorkflowToolActive = () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) pi.setActiveTools([...active, workflowTool.name]);
  };
  const ensureTrellisSubagentActive = () => {
    if (!trellisSubagentRegistered) return;
    const active = pi.getActiveTools();
    if (!active.includes("trellis_subagent")) pi.setActiveTools([...active, "trellis_subagent"]);
  };

  let latestHostCtx: ExtensionContext | undefined;
  let pluginModelRuntime: ModelRuntime | undefined;
  let pluginModelRuntimePromise: Promise<ModelRuntime> | undefined;

  const ensurePluginModelRuntime = async (): Promise<ModelRuntime> => {
    if (pluginModelRuntime) return pluginModelRuntime;
    if (!pluginModelRuntimePromise) {
      pluginModelRuntimePromise = createPluginModelRuntime()
        .then((runtime) => {
          pluginModelRuntime = runtime;
          return runtime;
        })
        .catch((error) => {
          pluginModelRuntimePromise = undefined;
          throw error;
        });
    }
    return pluginModelRuntimePromise;
  };

  const tryRegisterTrellisSubagent = (ctx?: ExtensionContext) => {
    if (ctx) latestHostCtx = ctx;
    if (trellisSubagentRegistered) return;
    if (!trellisCompatible || !shouldRegisterTrellisSubagentTool(cwd, settings.trellisAdapter)) return;
    if (hasRegisteredTrellisSubagentTool(pi)) {
      console.warn("[trellis-subagent-tool] skipped: tool already registered (native Trellis or another extension)");
      return;
    }
    // Lazy agent: rebuild each run so model runtime / trust / thinking stay current.
    const agent: Pick<WorkflowAgent, "run"> = {
      run: (async (prompt, opts) => {
        const host = latestHostCtx;
        const modelRuntime = await ensurePluginModelRuntime();
        const runner = new WorkflowAgent({
          cwd,
          projectTrusted: hostProjectTrusted,
          contextLoader: trellisContextLoader,
          sessionId: hostSessionId,
          extensionPathFilters: trellisEnabled ? [trellisExtensionPathFilter] : [],
          session: {
            model: host?.model,
            ...(hostThinkingLevel ? { thinkingLevel: hostThinkingLevel as never } : {}),
          },
          modelRegistry: host?.modelRegistry,
          modelRuntime,
          mainModel: host?.model ? `${host.model.provider}/${host.model.id}` : undefined,
        });
        return runner.run(prompt, opts);
      }) as WorkflowAgent["run"],
    };
    const tool = createTrellisSubagentTool({
      cwd,
      agent,
      contextLoader: trellisContextLoader,
      getSessionId: () => hostSessionId,
      getProjectTrusted: () => hostProjectTrusted,
      getThinkingLevel: () => hostThinkingLevel ?? pi.getThinkingLevel?.(),
      settings: settings.trellisAdapter,
    });
    pi.registerTool(tool);
    trellisSubagentRegistered = true;
    ensureTrellisSubagentActive();
  };

  const syncWorkflowRuntime = async (ctx: ExtensionContext, activateTool = false) => {
    const wasActive = pi.getActiveTools().includes(workflowTool.name);
    const modelRuntime = await ensurePluginModelRuntime();
    manager.setModelRuntime(modelRuntime);
    manager.setSessionOptions({ model: ctx.model });
    manager.setModelRegistry(ctx.modelRegistry);
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    manager.setThinkingLevel(pi.getThinkingLevel());
    hostThinkingLevel = pi.getThinkingLevel?.();
    // Inherit host project trust; ExtensionContext always exposes isProjectTrusted.
    hostProjectTrusted = ctx.isProjectTrusted();
    manager.setProjectTrusted(hostProjectTrusted);
    try {
      hostSessionId = ctx.sessionManager?.getSessionId();
      manager.setSessionId(hostSessionId);
    } catch {
      // Some headless contexts do not expose a session manager.
      hostSessionId = undefined;
      manager.setSessionId(undefined);
    }
    const availableModelSpecs = await listAvailableModelSpecsAsync(ctx.modelRegistry);
    workflowTool = createWorkflowTool({ cwd, manager, storage, modelRegistry: ctx.modelRegistry, availableModelSpecs });
    pi.registerTool(workflowTool);
    if (activateTool || wasActive) ensureWorkflowToolActive();
    // Register / re-check trellis_subagent after tools are live.
    tryRegisterTrellisSubagent(ctx);
  };
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with the editor's input hook below and
  // with the explicit /workflows run <prompt> manual trigger.
  const effort = createEffortState();
  registerWorkflowCommands(pi, manager, { storage, cwd, effort });
  registerWorkflowMainPromptFlag(pi);
  registerWorkflowMainPromptCommand(pi);
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { cwd, manager });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow(s)` to arm a forced workflow (animated),
  // Backspace right after the word disarms it. Registers the `input` hook now;
  // the editor itself is installed once the UI is available (session_start).
  let editorInstalled = false;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await syncWorkflowRuntime(ctx, true);
    manager.initialize();
    // Deliver a background run's result into the conversation when it finishes.
    // The live settings loader lets `deliveredResultMaxChars` take effect without
    // a restart.
    installResultDelivery(pi, manager, { loadSettings: () => loadWorkflowSettings({ cwd }) });
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
    if (!editorInstalled) {
      installWorkflowEditor(pi, ctx.ui, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      editorInstalled = true;
    }
  });

  pi.on("session_shutdown", async () => {
    await manager.dispose();
  });

  pi.on("input", async (_event, ctx) => {
    await syncWorkflowRuntime(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await syncWorkflowRuntime(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    manager.setThinkingLevel(event.level);
    hostThinkingLevel = event.level;
  });
}

function capabilityVersion(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}
