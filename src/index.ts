export type {
  TrellisAdapterEnabled,
  TrellisAdapterSettings,
  TrellisContextLoaderOptions,
  TrellisSubagentToolSetting,
} from "./adapters/trellis.js";
export {
  buildTrellisTaskContext,
  createTrellisContextLoader,
  hasNativeTrellisExtension,
  hasTrellisProject,
  isTrellisAgent,
  MAX_TRELLIS_MANIFEST_INDEX_BYTES,
  MAX_TRELLIS_TASK_ARTIFACT_BYTES,
  MAX_TRELLIS_TASK_CONTEXT_BYTES,
  normalizeTrellisAgentName,
  parseActiveTaskLine,
  resolveActiveTaskPath,
  resolveTrellisContextKey,
  shouldEnableTrellisAdapter,
  shouldRegisterTrellisSubagentTool,
  toRepoRelativePath,
  trellisExtensionPathFilter,
} from "./adapters/trellis.js";
export type {
  TrellisSubagentMode,
  TrellisSubagentProgressDetails,
  TrellisSubagentRunDetails,
  TrellisSubagentToolInput,
  TrellisSubagentToolOptions,
} from "./adapters/trellis-subagent-tool.js";
export {
  createTrellisSubagentTool,
  hasRegisteredTrellisSubagentTool,
  MAX_TRELLIS_PARALLEL_PROMPTS,
  TRELLIS_SUBAGENT_TOOL_NAME,
} from "./adapters/trellis-subagent-tool.js";
export type { AdversarialReviewConfig } from "./adversarial-review.js";
export { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "./adversarial-review.js";
export type {
  AgentRunOptions,
  AgentRunResult,
  ExtensionPathFilter,
  WorkflowAgentOptions,
  WrapResourceLoaderOptions,
} from "./agent.js";
export {
  createSubagentEnvInterceptorFactory,
  filterShadowingBuiltinCustomTools,
  isKnownTrellisChild,
  listAvailableModelSpecs,
  listAvailableModelSpecsAsync,
  resolveSessionToolAllowlist,
  WorkflowAgent,
  wrapResourceLoaderForWorkflowSubagents,
} from "./agent.js";
export type { AgentHistoryEntry, AgentHistoryKind, AgentHistoryRole } from "./agent-history.js";
export { compactAgentHistory } from "./agent-history.js";
export type { AgentDefinition, AgentRegistry } from "./agent-registry.js";
export { applyToolPolicy, listAgentTypes, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
export { registerBuiltinWorkflows } from "./builtin-commands.js";
export { generateCodeReviewWorkflow, MAX_DIFF_CHARS } from "./code-review.js";
export * from "./config.js";
export type { DeepResearchConfig } from "./deep-research.js";
export { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "./deep-research.js";
export type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowDisplay,
  WorkflowDisplayOptions,
  WorkflowSnapshot,
} from "./display.js";
export {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
} from "./display.js";
export {
  createEffortState,
  type EffortLevel,
  type EffortState,
  effortDirective,
  isSubstantive,
  registerEffortCommand,
} from "./effort-command.js";
export {
  isAbortError,
  isTimeoutError,
  isWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
  wrapError,
} from "./errors.js";
export type { WorkflowLogger, WorkflowLoggerOptions } from "./logger.js";
export { createWorkflowLogger } from "./logger.js";
export {
  disableWorkflowMainPrompt,
  enableWorkflowMainPrompt,
  formatWorkflowMainPromptDiagnostic,
  getWorkflowMainPromptSettingsPath,
  inspectWorkflowMainPrompt,
  isWorkflowMainPromptEnabled,
  loadWorkflowMainPrompt,
  MAX_WORKFLOW_MAIN_BYTES,
  registerWorkflowMainPromptCommand,
  registerWorkflowMainPromptFlag,
  WORKFLOW_MAIN_MARKER,
  WORKFLOW_MAIN_RELATIVE_PATH,
  type WorkflowMainPromptAccessOptions,
  type WorkflowMainPromptDiagnostic,
  type WorkflowMainPromptResult,
  type WorkflowMainPromptState,
} from "./main-agent-prompt.js";
export type { ModelRoute, ModelRoutingConfig } from "./model-routing.js";
export { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
export type { ModelListSource, RegisteredProviderSource } from "./model-runtime.js";
export {
  copyRegisteredProviders,
  createPluginModelRuntime,
  modelListFromRegistry,
  modelListFromRuntime,
} from "./model-runtime.js";
export type { ModelThinkingLevel, ResolvedModelSpec } from "./model-spec.js";
export {
  canonicalModelSpec,
  formatModelSpecWithThinking,
  isThinkingLevel,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
  THINKING_LEVELS,
} from "./model-spec.js";
export type { ModelTierConfig } from "./model-tier-config.js";
export {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  loadModelTierConfig,
  resolveTierModel,
  resolveTierThinkingLevel,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";
export type { ModelAvailabilitySource } from "./pi-compat.js";
export {
  getAvailableModels,
  getAvailableModelsSync,
  listAvailableModelSpecs as listAvailableModelSpecsCompat,
  listAvailableModelSpecsAsync as listAvailableModelSpecsAsyncCompat,
} from "./pi-compat.js";
export type { PersistedRunState, RunPersistence, RunStatus } from "./run-persistence.js";
export { createRunPersistence, generateRunId } from "./run-persistence.js";
export {
  parseCommandArgs,
  registerAllSavedWorkflows,
  registerSavedWorkflow,
} from "./saved-commands.js";
export { createSharedStoreTools, SharedStore } from "./shared-store.js";
export type { StructuredOutputCapture, StructuredOutputToolOptions } from "./structured-output.js";
export { createStructuredOutputTool } from "./structured-output.js";
export type { SubagentContext, SubagentContextLoader } from "./subagent-context.js";
export {
  applySubagentContext,
  commandAlreadySetsEnv,
  mergeSubagentEnv,
  noopSubagentContextLoader,
  prependEnvExports,
  shellQuoteEnvValue,
} from "./subagent-context.js";
export { deliverText, installResultDelivery, installTaskPanel, type TaskPanelOptions } from "./task-panel.js";
export { createWebFetchTool, createWebSearchTool, createWebTools } from "./web-tools.js";
export type {
  AgentOptions,
  JournalEntry,
  SharedRuntime,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./workflow.js";
export { parseWorkflowScript, runWorkflow } from "./workflow.js";
export { registerWorkflowCommands } from "./workflow-commands.js";
export {
  buildForcedWorkflowPrompt,
  colorizeWorkflow,
  endsWithTrigger,
  hasTrigger,
  type InstallWorkflowEditorOptions,
  installWorkflowEditor,
  RAINBOW,
  registerWorkflowProgressCommands,
  registerWorkflowTriggerCommand,
  tokenizeAnsi,
  WorkflowEditor,
  type WorkflowModeState,
} from "./workflow-editor.js";
export type { ManagedRun, WorkflowManagerOptions } from "./workflow-manager.js";
export { WorkflowManager } from "./workflow-manager.js";
export type { WorkflowProjectPaths } from "./workflow-paths.js";
export {
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "./workflow-paths.js";
export type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
export { assertSafeSavedWorkflowName, createWorkflowStorage, isSafeSavedWorkflowName } from "./workflow-saved.js";
export type {
  TrellisAdapterSetting,
  WorkflowSettings,
  WorkflowSettingsOptions,
  WorkflowSettingsStore,
} from "./workflow-settings.js";
export {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "./workflow-settings.js";
export type { WorkflowToolInput, WorkflowToolOptions } from "./workflow-tool.js";
export { backgroundStartedText, createWorkflowTool } from "./workflow-tool.js";
export {
  keyToAction,
  type NavAction,
  NavigatorModel,
  NavigatorState,
  openWorkflowNavigator,
  renderNavigator,
  type ViewKind,
} from "./workflow-ui.js";
export { registerWorkflowModelsCommand } from "./workflows-models-command.js";
export type { Worktree } from "./worktree.js";
export { createWorktree, removeWorktree } from "./worktree.js";
