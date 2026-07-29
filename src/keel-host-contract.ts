import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { SubagentContext } from "./subagent-context.js";

export const KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION = "keel.pi-host-descriptor/v1" as const;
export const KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION = "keel.pi-host-bridge/v1" as const;
export const KEEL_PI_INVOCATION_SCHEMA_VERSION = "keel.pi-invocation/v1" as const;
export const KEEL_PI_LIFECYCLE_OBSERVATION_SCHEMA_VERSION = "keel.pi-lifecycle-observation/v1" as const;

export const KEEL_PI_HOST_ABI = Object.freeze({ id: "pi-dynamic-workflows-host", version: 1 });
export const KEEL_REQUIRED_HOST_CAPABILITIES = Object.freeze([
  Object.freeze({ id: "context-snapshot-identity", version: 1 }),
  Object.freeze({ id: "logical-invocation-identity", version: 1 }),
  Object.freeze({ id: "controlled-context-tools", version: 1 }),
  Object.freeze({ id: "lifecycle-observation", version: 1 }),
]);

export const KEEL_CONTEXT_TOOL_CAPABILITIES = Object.freeze([
  "context.list",
  "context.read",
  "artifact.report",
] as const);

export type KeelContextToolCapability = (typeof KEEL_CONTEXT_TOOL_CAPABILITIES)[number];
export type KeelAgentRole = "keel-research" | "keel-implement" | "keel-check";
export type KeelLifecycleDelivery = "live" | "cached_replay";

export type KeelPiHostCapability = Readonly<{ id: string; version: number }>;
export type KeelPiHostDescriptor = Readonly<{
  schemaVersion: typeof KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION;
  abi: Readonly<{ id: string; version: number }>;
  source: Readonly<{
    revision: string;
    packageVersion?: string;
    distribution: "maintained-fork-checkout" | "upstream-checkout" | "vendored";
  }>;
  capabilities: readonly KeelPiHostCapability[];
}>;

export type KeelPiInvocationV1 = Readonly<{
  schemaVersion: typeof KEEL_PI_INVOCATION_SCHEMA_VERSION;
  workflowInstanceId: string;
  stepRunId: string;
  agentRunId: string;
  logicalInvocationId: string;
  contextSnapshotId: string;
  idempotencyKey: string;
  role: KeelAgentRole;
  allowedContextTools: readonly KeelContextToolCapability[];
}>;

export type KeelPiSourceReference = Readonly<{
  workflowRunId: string;
  callIndex: number;
}>;

export type KeelPiTerminalOutcome =
  | Readonly<{ status: "succeeded"; artifactRevisionId?: string }>
  | Readonly<{ status: "failed"; code: string; message: string; recoverable: boolean }>
  | Readonly<{ status: "cancelled"; reason?: string }>;

type KeelPiObservationBase = Readonly<{
  schemaVersion: typeof KEEL_PI_LIFECYCLE_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  logicalInvocationId: string;
  agentRunId: string;
  contextSnapshotId: string;
  source: KeelPiSourceReference;
  delivery: KeelLifecycleDelivery;
}>;

export type KeelPiLifecycleObservation =
  | (KeelPiObservationBase & Readonly<{ kind: "started" }>)
  | (KeelPiObservationBase & Readonly<{ kind: "terminal"; outcome: KeelPiTerminalOutcome }>);

export type KeelContextToolBinding = Readonly<{
  capability: KeelContextToolCapability;
  tool: ToolDefinition;
}>;

export type KeelInvocationLoadInput = Readonly<{
  source: KeelPiSourceReference;
  label: string;
  phase?: string;
  agentType?: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
}>;

export type KeelLoadedInvocationV1 = Readonly<{
  invocation: KeelPiInvocationV1;
  observationIds: Readonly<{ started: string; terminal: string }>;
  context?: SubagentContext;
  contextTools?: readonly KeelContextToolBinding[];
}>;

export interface KeelHostBridgeV1 {
  readonly schemaVersion: typeof KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION;
  readonly descriptor: KeelPiHostDescriptor;
  loadInvocation(input: KeelInvocationLoadInput): Promise<KeelLoadedInvocationV1>;
  observe(observation: KeelPiLifecycleObservation): void | Promise<void>;
}

export function createKeelPiHostDescriptor(source: KeelPiHostDescriptor["source"]): KeelPiHostDescriptor {
  return normalizeDescriptor({
    schemaVersion: KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION,
    abi: KEEL_PI_HOST_ABI,
    source,
    capabilities: KEEL_REQUIRED_HOST_CAPABILITIES,
  });
}

const STABLE_ID_MAX_LENGTH = 200;
const RESERVED_SYSTEM_TOOL_NAMES = new Set([
  "store_put",
  "store_get",
  "structured_output",
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

function contractError(message: string, details?: unknown): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.KEEL_HOST_CONTRACT_ERROR, {
    recoverable: false,
    details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= STABLE_ID_MAX_LENGTH;
}

function stableId(value: unknown, field: string): string {
  if (!isStableId(value)) throw contractError(`${field} is malformed`);
  return value.trim();
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function normalizeDescriptor(value: unknown): KeelPiHostDescriptor {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "abi", "source", "capabilities"])) {
    throw contractError("Keel host descriptor is malformed");
  }
  if (value.schemaVersion !== KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION) {
    throw contractError("Keel host descriptor schema is incompatible");
  }
  if (!isRecord(value.abi) || !hasOnlyKeys(value.abi, ["id", "version"])) {
    throw contractError("Keel host ABI is malformed");
  }
  if (value.abi.id !== KEEL_PI_HOST_ABI.id || value.abi.version !== KEEL_PI_HOST_ABI.version) {
    throw contractError("Keel host ABI is incompatible");
  }
  if (!isRecord(value.source) || !hasOnlyKeys(value.source, ["revision", "packageVersion", "distribution"])) {
    throw contractError("Keel host source provenance is malformed");
  }
  const revision = value.source.revision;
  const packageVersion = value.source.packageVersion;
  const distribution = value.source.distribution;
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision)) {
    throw contractError("Keel host source revision is malformed");
  }
  if (
    packageVersion !== undefined &&
    (typeof packageVersion !== "string" || packageVersion.trim().length === 0 || packageVersion.trim().length > 100)
  ) {
    throw contractError("Keel host package version is malformed");
  }
  if (
    typeof distribution !== "string" ||
    !["maintained-fork-checkout", "upstream-checkout", "vendored"].includes(distribution)
  ) {
    throw contractError("Keel host source distribution is malformed");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64) {
    throw contractError("Keel host capabilities are malformed");
  }
  const capabilities = value.capabilities.map((capability) => {
    if (!isRecord(capability) || !hasOnlyKeys(capability, ["id", "version"])) {
      throw contractError("Keel host capability is malformed");
    }
    if (
      typeof capability.id !== "string" ||
      capability.id.trim().length === 0 ||
      capability.id.trim().length > 100 ||
      !isPositiveInteger(capability.version)
    ) {
      throw contractError("Keel host capability is malformed");
    }
    return Object.freeze({ id: capability.id.trim(), version: capability.version });
  });
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) {
    throw contractError("Keel host capability IDs must be unique");
  }
  for (const required of KEEL_REQUIRED_HOST_CAPABILITIES) {
    const provided = capabilities.find((capability) => capability.id === required.id);
    if (!provided || provided.version !== required.version) {
      throw contractError(`Keel host capability ${required.id}@${required.version} is required`);
    }
  }
  return Object.freeze({
    schemaVersion: KEEL_PI_HOST_DESCRIPTOR_SCHEMA_VERSION,
    abi: KEEL_PI_HOST_ABI,
    source: Object.freeze({
      revision,
      ...(typeof packageVersion === "string" ? { packageVersion: packageVersion.trim() } : {}),
      distribution: distribution as KeelPiHostDescriptor["source"]["distribution"],
    }),
    capabilities: Object.freeze(capabilities),
  });
}

function normalizeInvocation(value: unknown): KeelPiInvocationV1 {
  const keys = [
    "schemaVersion",
    "workflowInstanceId",
    "stepRunId",
    "agentRunId",
    "logicalInvocationId",
    "contextSnapshotId",
    "idempotencyKey",
    "role",
    "allowedContextTools",
  ] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || value.schemaVersion !== KEEL_PI_INVOCATION_SCHEMA_VERSION) {
    throw contractError("Keel invocation is malformed");
  }
  for (const key of [
    "workflowInstanceId",
    "stepRunId",
    "agentRunId",
    "logicalInvocationId",
    "contextSnapshotId",
    "idempotencyKey",
  ] as const) {
    if (!isStableId(value[key])) throw contractError(`Keel invocation ${key} is malformed`);
  }
  if (typeof value.role !== "string" || !["keel-research", "keel-implement", "keel-check"].includes(value.role)) {
    throw contractError("Keel invocation role is malformed");
  }
  if (
    !Array.isArray(value.allowedContextTools) ||
    value.allowedContextTools.length === 0 ||
    value.allowedContextTools.length > KEEL_CONTEXT_TOOL_CAPABILITIES.length
  ) {
    throw contractError("Keel invocation context-tool allowlist is malformed");
  }
  const allowedContextTools = value.allowedContextTools.map((capability) => {
    if (!KEEL_CONTEXT_TOOL_CAPABILITIES.includes(capability as KeelContextToolCapability)) {
      throw contractError("Keel invocation context-tool allowlist is malformed");
    }
    return capability as KeelContextToolCapability;
  });
  if (new Set(allowedContextTools).size !== allowedContextTools.length) {
    throw contractError("Keel invocation context-tool allowlist must be unique");
  }
  return Object.freeze({
    schemaVersion: KEEL_PI_INVOCATION_SCHEMA_VERSION,
    workflowInstanceId: stableId(value.workflowInstanceId, "Keel workflow instance ID"),
    stepRunId: stableId(value.stepRunId, "Keel step run ID"),
    agentRunId: stableId(value.agentRunId, "Keel agent run ID"),
    logicalInvocationId: stableId(value.logicalInvocationId, "Keel logical invocation ID"),
    contextSnapshotId: stableId(value.contextSnapshotId, "Keel context snapshot ID"),
    idempotencyKey: stableId(value.idempotencyKey, "Keel idempotency key"),
    role: value.role as KeelAgentRole,
    allowedContextTools: Object.freeze(allowedContextTools),
  });
}

function normalizeContext(value: unknown): SubagentContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["promptPrefix", "instructions", "env"])) {
    throw contractError("Keel subagent context is malformed");
  }
  if (value.promptPrefix !== undefined && typeof value.promptPrefix !== "string") {
    throw contractError("Keel context prompt prefix is malformed");
  }
  if (value.instructions !== undefined && typeof value.instructions !== "string") {
    throw contractError("Keel context instructions are malformed");
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    if (
      !isRecord(value.env) ||
      Object.entries(value.env).some(
        ([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string",
      )
    ) {
      throw contractError("Keel context environment is malformed");
    }
    env = Object.fromEntries(Object.entries(value.env).sort(([left], [right]) => left.localeCompare(right))) as Record<
      string,
      string
    >;
  }
  return Object.freeze({
    ...(typeof value.promptPrefix === "string" ? { promptPrefix: value.promptPrefix } : {}),
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    ...(env ? { env: Object.freeze(env) } : {}),
  });
}

function normalizeContextTools(value: unknown, invocation: KeelPiInvocationV1): readonly KeelContextToolBinding[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > KEEL_CONTEXT_TOOL_CAPABILITIES.length) {
    throw contractError("Keel context-tool bindings are malformed");
  }
  const capabilities = new Set<KeelContextToolCapability>();
  const names = new Set<string>();
  const bindings = value.map((binding) => {
    if (!isRecord(binding) || !hasOnlyKeys(binding, ["capability", "tool"])) {
      throw contractError("Keel context-tool binding is malformed");
    }
    if (!KEEL_CONTEXT_TOOL_CAPABILITIES.includes(binding.capability as KeelContextToolCapability)) {
      throw contractError("Keel context-tool capability is malformed");
    }
    const capability = binding.capability as KeelContextToolCapability;
    if (!invocation.allowedContextTools.includes(capability)) {
      throw contractError(`Keel context-tool capability ${capability} is not allowed`);
    }
    if (capabilities.has(capability)) throw contractError(`Keel context-tool capability ${capability} is duplicated`);
    if (
      !isRecord(binding.tool) ||
      !isStableId(binding.tool.name) ||
      typeof binding.tool.execute !== "function" ||
      typeof binding.tool.label !== "string" ||
      typeof binding.tool.description !== "string" ||
      !("parameters" in binding.tool)
    ) {
      throw contractError(`Keel context-tool binding ${capability} is not a valid tool definition`);
    }
    const name = binding.tool.name.trim();
    if (name !== binding.tool.name) {
      throw contractError(`Keel context-tool name ${binding.tool.name} is malformed`);
    }
    if (RESERVED_SYSTEM_TOOL_NAMES.has(name) || names.has(name)) {
      throw contractError(`Keel context-tool name ${name} collides with another tool`);
    }
    capabilities.add(capability);
    names.add(name);
    return Object.freeze({ capability, tool: binding.tool as unknown as ToolDefinition });
  });
  return Object.freeze(bindings);
}

export function validateKeelHostBridge(bridge: unknown): KeelHostBridgeV1 {
  if (!isRecord(bridge) || bridge.schemaVersion !== KEEL_PI_HOST_BRIDGE_SCHEMA_VERSION) {
    throw contractError("Keel host bridge is malformed");
  }
  normalizeDescriptor(bridge.descriptor);
  if (typeof bridge.loadInvocation !== "function" || typeof bridge.observe !== "function") {
    throw contractError("Keel host bridge callbacks are malformed");
  }
  return bridge as unknown as KeelHostBridgeV1;
}

export async function loadKeelAgentInvocation(
  bridgeValue: unknown,
  input: KeelInvocationLoadInput,
): Promise<KeelLoadedInvocationV1> {
  const bridge = validateKeelHostBridge(bridgeValue);
  if (
    !isStableId(input.source.workflowRunId) ||
    !Number.isInteger(input.source.callIndex) ||
    input.source.callIndex < 0
  ) {
    throw contractError("Keel workflow source reference is malformed");
  }
  let loaded: unknown;
  try {
    loaded = await bridge.loadInvocation(input);
  } catch (error) {
    throw contractError("Keel host could not load invocation context", error);
  }
  if (!isRecord(loaded) || !hasOnlyKeys(loaded, ["invocation", "observationIds", "context", "contextTools"])) {
    throw contractError("Keel loaded invocation is malformed");
  }
  const invocation = normalizeInvocation(loaded.invocation);
  if (!isRecord(loaded.observationIds) || !hasOnlyKeys(loaded.observationIds, ["started", "terminal"])) {
    throw contractError("Keel observation identities are malformed");
  }
  const startedObservationId = stableId(loaded.observationIds.started, "Keel started observation ID");
  const terminalObservationId = stableId(loaded.observationIds.terminal, "Keel terminal observation ID");
  if (startedObservationId === terminalObservationId) {
    throw contractError("Keel observation identities must be distinct");
  }
  return Object.freeze({
    invocation,
    observationIds: Object.freeze({
      started: startedObservationId,
      terminal: terminalObservationId,
    }),
    ...(loaded.context === undefined ? {} : { context: normalizeContext(loaded.context) }),
    contextTools: normalizeContextTools(loaded.contextTools, invocation),
  });
}

function observationBase(
  loaded: KeelLoadedInvocationV1,
  source: KeelPiSourceReference,
  delivery: KeelLifecycleDelivery,
  observationId: string,
): KeelPiObservationBase {
  return {
    schemaVersion: KEEL_PI_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
    observationId,
    logicalInvocationId: loaded.invocation.logicalInvocationId,
    agentRunId: loaded.invocation.agentRunId,
    contextSnapshotId: loaded.invocation.contextSnapshotId,
    source: Object.freeze({ workflowRunId: source.workflowRunId.trim(), callIndex: source.callIndex }),
    delivery,
  };
}

export async function observeKeelAgentStarted(
  bridgeValue: unknown,
  loaded: KeelLoadedInvocationV1,
  source: KeelPiSourceReference,
  delivery: KeelLifecycleDelivery,
): Promise<void> {
  const bridge = validateKeelHostBridge(bridgeValue);
  try {
    await bridge.observe({
      ...observationBase(loaded, source, delivery, loaded.observationIds.started),
      kind: "started",
    });
  } catch (error) {
    throw contractError("Keel host rejected the started observation", error);
  }
}

export async function observeKeelAgentTerminal(
  bridgeValue: unknown,
  loaded: KeelLoadedInvocationV1,
  source: KeelPiSourceReference,
  delivery: KeelLifecycleDelivery,
  outcome: KeelPiTerminalOutcome,
): Promise<void> {
  const bridge = validateKeelHostBridge(bridgeValue);
  const normalizedOutcome: KeelPiTerminalOutcome =
    outcome.status === "succeeded"
      ? {
          status: "succeeded",
          ...(outcome.artifactRevisionId
            ? { artifactRevisionId: stableId(outcome.artifactRevisionId, "Keel artifact revision ID") }
            : {}),
        }
      : outcome.status === "failed"
        ? {
            status: "failed",
            code: outcome.code.trim().slice(0, 100) || "UNKNOWN",
            message: outcome.message.trim().slice(0, 2_000) || "Unknown workflow failure",
            recoverable: outcome.recoverable,
          }
        : {
            status: "cancelled",
            ...(outcome.reason?.trim() ? { reason: outcome.reason.trim().slice(0, 2_000) } : {}),
          };
  try {
    await bridge.observe({
      ...observationBase(loaded, source, delivery, loaded.observationIds.terminal),
      kind: "terminal",
      outcome: normalizedOutcome,
    });
  } catch (error) {
    throw contractError("Keel host rejected the terminal observation", error);
  }
}
