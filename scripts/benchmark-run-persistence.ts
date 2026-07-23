import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRunPersistence, type PersistedRunState, type RunLease } from "../src/run-persistence.js";
import { createWorkflowPanelSnapshot, renderPanel, type WorkflowPanelSnapshot } from "../src/task-panel.js";

const RUN_COUNT = 500;
const PAYLOAD_BYTES = 128 * 1024;
const MAX_ACTIVE_HEARTBEATS = 16;
const HEARTBEAT_ROUNDS = 20;

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function measure(label: string, operation: () => void, iterations = 1): void {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  console.log(
    `${label}: median=${percentile(samples, 0.5).toFixed(3)}ms p95=${percentile(samples, 0.95).toFixed(3)}ms iterations=${iterations}`,
  );
}

async function heartbeatScenario(
  count: number,
  acquire: (runId: string) => RunLease,
  renew: (lease: RunLease) => boolean,
  release: (lease: RunLease) => void,
): Promise<void> {
  const leases = Array.from({ length: count }, (_, index) => acquire(`heartbeat-${count}-${index}`));
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const started = performance.now();
  for (let round = 0; round < HEARTBEAT_ROUNDS; round += 1) {
    for (const lease of leases) {
      if (!renew(lease)) throw new Error("Lease renewal unexpectedly lost ownership.");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const elapsed = performance.now() - started;
  delay.disable();
  console.log(
    `heartbeat x${count}: ${(count * HEARTBEAT_ROUNDS).toLocaleString()} renewals in ${elapsed.toFixed(1)}ms, event-loop p99=${(delay.percentile(99) / 1e6).toFixed(3)}ms max=${(delay.max / 1e6).toFixed(3)}ms`,
  );
  for (const lease of leases) release(lease);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-persistence-benchmark-"));
  const cwd = join(root, "project");
  const path = join(root, "workflows.sqlite3");
  const repository = createRunPersistence(cwd, { path });
  try {
    const privateResult = "x".repeat(PAYLOAD_BYTES);
    for (let index = 0; index < RUN_COUNT; index += 1) {
      const runId = `benchmark-${index}`;
      const lease = repository.acquireRunLease(runId, "new");
      if (!lease) throw new Error(`Could not acquire seed lease ${runId}.`);
      const timestamp = new Date(1_750_000_000_000 + index).toISOString();
      repository.save(
        {
          runId,
          sessionId: "benchmark-session",
          workflowName: "benchmark",
          script: "return 'ok'",
          status: "completed",
          phases: ["Measure"],
          agents: [{ id: 1, label: "seed", prompt: "private", status: "done", result: privateResult }],
          logs: [],
          result: privateResult,
          startedAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        },
        lease,
      );
      repository.releaseRunLease(lease);
    }

    measure("summary list (500 rows, payload-free)", () => repository.listSummaries("benchmark-session"), 30);
    measure("keyed 256 KiB-class payload load", () => repository.load("benchmark-250"), 50);

    const saveLease = repository.acquireRunLease("benchmark-250", "existing");
    if (!saveLease) throw new Error("Could not acquire save benchmark lease.");
    const saveState = repository.load("benchmark-250") as PersistedRunState;
    measure(
      "fenced summary+payload transaction",
      () => repository.save({ ...saveState, currentPhase: "Measure" }, saveLease),
      30,
    );
    repository.releaseRunLease(saveLease);

    let persistenceCalls = 0;
    const manager = {
      listRuns: () => {
        persistenceCalls += 1;
        return repository.listSummaries("benchmark-session");
      },
      getRun: () => undefined,
    };
    const snapshot: WorkflowPanelSnapshot = createWorkflowPanelSnapshot(manager as never);
    persistenceCalls = 0;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    measure("1,000 pure panel renders", () => renderPanel(snapshot, theme as never, 120), 1_000);
    console.log(`render persistence calls after snapshot: ${persistenceCalls}`);
    if (persistenceCalls !== 0) throw new Error("Render path called persistence after snapshot preparation.");

    const acquire = (runId: string) => {
      const lease = repository.acquireRunLease(runId, "new");
      if (!lease) throw new Error(`Could not acquire heartbeat lease ${runId}.`);
      return lease;
    };
    await heartbeatScenario(1, acquire, repository.renewRunLease, repository.releaseRunLease);
    await heartbeatScenario(8, acquire, repository.renewRunLease, repository.releaseRunLease);
    await heartbeatScenario(MAX_ACTIVE_HEARTBEATS, acquire, repository.renewRunLease, repository.releaseRunLease);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
