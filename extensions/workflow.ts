import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createEffortState,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  listAvailableModelSpecsAsync,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  WorkflowManager,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const settings = loadWorkflowSettings({ cwd });
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
  });

  let workflowTool = createWorkflowTool({ cwd, manager, storage });
  pi.registerTool(workflowTool);

  const ensureWorkflowToolActive = () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  };

  const syncWorkflowRuntime = async (ctx: ExtensionContext, options?: { activateTool?: boolean }) => {
    const workflowToolWasActive = pi.getActiveTools().includes(workflowTool.name);
    manager.setSessionOptions({ modelRegistry: ctx.modelRegistry, model: ctx.model });
    manager.setModelRegistry(ctx.modelRegistry);
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    manager.setThinkingLevel(pi.getThinkingLevel());
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }

    const availableModelSpecs = await listAvailableModelSpecsAsync(ctx.modelRegistry);
    workflowTool = createWorkflowTool({
      cwd,
      manager,
      storage,
      modelRegistry: ctx.modelRegistry,
      availableModelSpecs,
    });
    pi.registerTool(workflowTool);
    if (options?.activateTool || workflowToolWasActive) {
      ensureWorkflowToolActive();
    }
  };

  const effort = createEffortState();
  registerWorkflowCommands(pi, manager, { storage, cwd, effort });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { cwd, manager });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  let editorInstalled = false;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await syncWorkflowRuntime(ctx, { activateTool: true });
    installResultDelivery(pi, manager);
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

  pi.on("input", async (_event, ctx) => {
    await syncWorkflowRuntime(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await syncWorkflowRuntime(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    manager.setThinkingLevel(event.level);
  });
}
