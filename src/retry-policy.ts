import type { HostRetryPolicySnapshot } from "@earendil-works/pi-coding-agent";
import { MAX_AGENT_RETRIES } from "./config.js";

export interface AgentTurnRetryOverride {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface WorkflowExecutionPolicy {
  agentTurnRetry?: AgentTurnRetryOverride;
  agentRunRetries?: number;
}

export type ImmutableHostRetryPolicySnapshot = Readonly<{
  agentTurn: Readonly<HostRetryPolicySnapshot["agentTurn"]>;
  providerRequest: Readonly<HostRetryPolicySnapshot["providerRequest"]>;
}>;

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a finite non-negative safe integer`);
  }
  return value as number;
}

function optionalNonNegativeSafeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : nonNegativeSafeInteger(value, name);
}

export function normalizeAgentTurnRetryOverride(
  value: unknown,
  name = "agentTurnRetry",
): AgentTurnRetryOverride | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "enabled" && key !== "maxRetries" && key !== "baseDelayMs") {
      throw new Error(`${name}.${key} is not supported`);
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error(`${name}.enabled must be a boolean`);
  }
  const normalized: AgentTurnRetryOverride = {};
  if (input.enabled !== undefined) normalized.enabled = input.enabled;
  const maxRetries = optionalNonNegativeSafeInteger(input.maxRetries, `${name}.maxRetries`);
  if (maxRetries !== undefined) normalized.maxRetries = maxRetries;
  const baseDelayMs = optionalNonNegativeSafeInteger(input.baseDelayMs, `${name}.baseDelayMs`);
  if (baseDelayMs !== undefined) normalized.baseDelayMs = baseDelayMs;
  return normalized;
}

export function normalizeAgentRunRetries(value: unknown, name = "agentRunRetries"): number {
  const normalized = nonNegativeSafeInteger(value, name);
  if (normalized > MAX_AGENT_RETRIES) {
    throw new Error(`${name} must be between 0 and ${MAX_AGENT_RETRIES}`);
  }
  return normalized;
}

export function resolveAgentRunRetries(
  canonical: unknown,
  alias: unknown,
  options: { canonicalName?: string; aliasName: string; fallback?: number } = { aliasName: "agentRetries" },
): number {
  const canonicalName = options.canonicalName ?? "agentRunRetries";
  if (canonical !== undefined && alias !== undefined) {
    throw new Error(`${canonicalName} conflicts with deprecated ${options.aliasName}`);
  }
  const selected = canonical ?? alias ?? options.fallback ?? 0;
  return normalizeAgentRunRetries(selected, canonical !== undefined ? canonicalName : options.aliasName);
}

export function normalizeExecutionPolicy(value: {
  agentTurnRetry?: unknown;
  agentRunRetries?: unknown;
  agentRetries?: unknown;
}): WorkflowExecutionPolicy {
  const agentTurnRetry = normalizeAgentTurnRetryOverride(value.agentTurnRetry);
  const hasAgentRunRetries = value.agentRunRetries !== undefined || value.agentRetries !== undefined;
  const agentRunRetries = hasAgentRunRetries
    ? resolveAgentRunRetries(value.agentRunRetries, value.agentRetries, { aliasName: "agentRetries" })
    : undefined;
  return {
    ...(agentTurnRetry ? { agentTurnRetry } : {}),
    ...(agentRunRetries !== undefined ? { agentRunRetries } : {}),
  };
}

export function readRequiredHostRetryPolicy(ctx: { getRetryPolicy?: unknown }): ImmutableHostRetryPolicySnapshot {
  if (typeof ctx.getRetryPolicy !== "function") {
    throw new Error("Pi host retry policy snapshot getter is unavailable");
  }
  return normalizeHostRetryPolicySnapshot(ctx.getRetryPolicy());
}

export function normalizeHostRetryPolicySnapshot(value: unknown): ImmutableHostRetryPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi host retry policy snapshot is invalid");
  }
  const snapshot = value as Partial<HostRetryPolicySnapshot>;
  if (!snapshot.agentTurn || !snapshot.providerRequest) {
    throw new Error("Pi host retry policy snapshot is incomplete");
  }
  if (typeof snapshot.agentTurn.enabled !== "boolean") {
    throw new Error("Pi host retry policy snapshot agentTurn.enabled is invalid");
  }
  const agentTurn = Object.freeze({
    enabled: snapshot.agentTurn.enabled,
    maxRetries: nonNegativeSafeInteger(snapshot.agentTurn.maxRetries, "host agentTurn.maxRetries"),
    baseDelayMs: nonNegativeSafeInteger(snapshot.agentTurn.baseDelayMs, "host agentTurn.baseDelayMs"),
  });
  const providerRequest = Object.freeze({
    timeoutMs: optionalNonNegativeSafeInteger(snapshot.providerRequest.timeoutMs, "host providerRequest.timeoutMs"),
    maxRetries: optionalNonNegativeSafeInteger(snapshot.providerRequest.maxRetries, "host providerRequest.maxRetries"),
    maxRetryDelayMs: nonNegativeSafeInteger(
      snapshot.providerRequest.maxRetryDelayMs,
      "host providerRequest.maxRetryDelayMs",
    ),
  });
  return Object.freeze({ agentTurn, providerRequest });
}

export function resolveAgentTurnRetry(
  host: ImmutableHostRetryPolicySnapshot["agentTurn"],
  runOverride?: AgentTurnRetryOverride,
  agentOverride?: AgentTurnRetryOverride,
): HostRetryPolicySnapshot["agentTurn"] {
  return { ...host, ...runOverride, ...agentOverride };
}

export function childRetrySettings(
  host: ImmutableHostRetryPolicySnapshot,
  runOverride?: AgentTurnRetryOverride,
  agentOverride?: AgentTurnRetryOverride,
): {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  provider: HostRetryPolicySnapshot["providerRequest"];
} {
  return {
    ...resolveAgentTurnRetry(host.agentTurn, runOverride, agentOverride),
    provider: {
      timeoutMs: host.providerRequest.timeoutMs,
      maxRetries: host.providerRequest.maxRetries,
      maxRetryDelayMs: host.providerRequest.maxRetryDelayMs,
    },
  };
}
