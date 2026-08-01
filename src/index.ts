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
  hasSupportedTrellisProject,
  hasTrellisProject,
  isTrellisAgent,
  MAX_TRELLIS_MANIFEST_INDEX_BYTES,
  MAX_TRELLIS_TASK_ARTIFACT_BYTES,
  MAX_TRELLIS_TASK_CONTEXT_BYTES,
  normalizeTrellisAgentName,
  parseActiveTaskLine,
  resolveActiveTaskPath,
  resolveTrellisContextKey,
  SUPPORTED_TRELLIS_PROJECT_VERSION,
  shouldEnableTrellisAdapter,
  shouldRegisterTrellisSubagentTool,
  toRepoRelativePath,
  trellisExtensionPathFilter,
  trellisProjectVersion,
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
export type {
  KeelAgentRole,
  KeelContextToolBinding,
  KeelContextToolCapability,
  KeelHostBridgeV1,
  KeelInvocationLoadInput,
  KeelLifecycleDelivery,
  KeelLoadedInvocationV1,
  KeelPiHostCapability,
  KeelPiHostDescriptor,
  KeelPiInvocationV1,
  KeelPiLifecycleObservation,
  KeelPiSourceReference,
  KeelPiTerminalOutcome,
} from "./keel-host-contract.js";
export {
  createKeelPiHostDescriptor,
  KEEL_CONTEXT_TOOL_CAPABILITIES,
  KEEL_PI_HOST_ABI,
  KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION,
  KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION,
  KEEL_PI_INVOCATION_SCHEMA_VERSION,
  KEEL_PI_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
  KEEL_REQUIRED_HOST_CAPABILITIES,
  validateKeelHostBridge,
} from "./keel-host-contract.js";
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
export type {
  AvailableModelSource,
  ModelRegistrySource,
  ModelThinkingLevel,
  ResolvedWorkflowModel,
  WorkflowModelSetting,
  WorkflowModelSnapshot,
} from "./model-selection.js";
export {
  canonicalModelSpec,
  defaultModelEffort,
  listAvailableModels,
  listRegisteredModels,
  resolveAgentModelOverride,
  resolveAvailableModel,
  resolveRegisteredModel,
  resolveWorkflowModel,
  resolveWorkflowModelSnapshot,
  supportedModelEfforts,
  validateModelEffort,
} from "./model-selection.js";
export type { ModelAvailabilitySource } from "./pi-compat.js";
export {
  getAvailableModels,
  getAvailableModelsSync,
  listAvailableModelSpecs as listAvailableModelSpecsCompat,
  listAvailableModelSpecsAsync as listAvailableModelSpecsAsyncCompat,
} from "./pi-compat.js";
export type {
  AgentTurnRetryOverride,
  ImmutableHostRetryPolicySnapshot,
  WorkflowExecutionPolicy,
} from "./retry-policy.js";
export {
  childRetrySettings,
  normalizeAgentRunRetries,
  normalizeAgentTurnRetryOverride,
  normalizeExecutionPolicy,
  normalizeHostRetryPolicySnapshot,
  readRequiredHostRetryPolicy,
  resolveAgentRunRetries,
  resolveAgentTurnRetry,
} from "./retry-policy.js";
export type { DeleteRunResult, PersistedRunState, RunStatus, WorkflowRunSummary } from "./run-persistence.js";
export { generateRunId, RUN_LEASE_HEARTBEAT_INTERVAL_MS, RUN_LEASE_STALE_AFTER_MS } from "./run-persistence.js";
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
  mergeSubagentContexts,
  mergeSubagentEnv,
  noopSubagentContextLoader,
  prependEnvExports,
  shellQuoteEnvValue,
} from "./subagent-context.js";
export {
  createWorkflowPanelSnapshot,
  deliverText,
  installResultDelivery,
  installTaskPanel,
  type TaskPanelOptions,
  type WorkflowPanelRunSnapshot,
  type WorkflowPanelSnapshot,
} from "./task-panel.js";
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
export { assertStructuredOutputEnabled, parseWorkflowScript, runWorkflow } from "./workflow.js";
export { registerWorkflowCommands } from "./workflow-commands.js";
export {
  assertSupportedNodeRuntime,
  WORKFLOW_DATABASE_APPLICATION_ID,
  WORKFLOW_DATABASE_BUSY_TIMEOUT_MS,
  WORKFLOW_DATABASE_SCHEMA_VERSION,
  WORKFLOW_PAYLOAD_VERSION,
  WorkflowPersistenceError,
} from "./workflow-database.js";
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
  WORKFLOW_DATABASE_FILENAME,
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowCanonicalProjectPath,
  workflowDatabasePath,
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
  clearWorkflowModelSetting,
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  isWorkflowStructuredOutputEnabled,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
  structuredOutputDisabledGuidance,
  WORKFLOW_STRUCTURED_OUTPUT_OPT_IN,
  WORKFLOW_STRUCTURED_OUTPUT_SETTINGS_PATH,
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
