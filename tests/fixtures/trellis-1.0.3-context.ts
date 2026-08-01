import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TRELLIS_1_0_3_TEMPLATE_SHA256 = "c3bc03d5f3d6ee0ed2bd93c73344f95b0ac01217a515ea602af8d978398b2fcb";

export const TRELLIS_1_0_3_LIMITS = {
  taskContext: 128 * 1024,
  taskArtifact: 64 * 1024,
  manifestIndex: 32 * 1024,
  manifestSource: 256 * 1024,
  manifestEntries: 256,
  reasonCodePoints: 240,
} as const;

export const TRELLIS_1_0_3_NOTICES = {
  artifact: "[Truncated {path} at 65536 UTF-8 bytes; load the remainder on demand.]",
  manifestSource: "[Stopped reading implement.jsonl after 262144 bytes; load the remainder on demand.]",
  manifestEntry: "[Omitted additional entries from implement.jsonl after 256; load the manifest on demand.]",
  manifestRendered: "[Truncated rendered index for implement.jsonl; load the manifest on demand.]",
} as const;

export function trellisArtifactNotice(path: string): string {
  return TRELLIS_1_0_3_NOTICES.artifact.replace("{path}", path);
}

/**
 * Literal golden payload captured from the frozen Trellis 1.0.3 renderer.
 * Keep this independent from the adapter implementation so V01 detects format
 * drift rather than merely reassembling the implementation's current output.
 */
export const V01_TRELLIS_1_0_3_PAYLOAD = `## Trellis Task Context

Task directory: .trellis/tasks/vector

### .trellis/tasks/vector/prd.md (Requirements)
# Requirements
Ship the adapter.


### .trellis/tasks/vector/design.md (Technical Design)
# Technical Design
Keep payload bytes stable.


### .trellis/tasks/vector/implement.md (Execution Plan)
# Execution Plan
Run the vectors.
`;

export function writeCanonicalTaskFixture(cwd: string, taskName = "vector"): string {
  const taskDir = join(cwd, ".trellis", "tasks", taskName);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(cwd, ".trellis", ".version"), "1.0.3\n", "utf-8");
  writeFileSync(join(taskDir, "prd.md"), "# Requirements\nShip the adapter.\n", "utf-8");
  writeFileSync(join(taskDir, "design.md"), "# Technical Design\nKeep payload bytes stable.\n", "utf-8");
  writeFileSync(join(taskDir, "implement.md"), "# Execution Plan\nRun the vectors.\n", "utf-8");
  return taskDir;
}
