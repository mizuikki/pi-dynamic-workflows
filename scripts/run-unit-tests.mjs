import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const testHome = mkdtempSync(join(tmpdir(), "pi-dw-tests-home-"));

try {
  const result = spawnSync(process.execPath, [tsxCli, "--test", "tests/**/*.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testHome, { recursive: true, force: true });
}
