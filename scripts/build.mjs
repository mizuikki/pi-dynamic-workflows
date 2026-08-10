import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repositoryRoot, "dist");

if (dirname(outputDirectory) !== repositoryRoot || outputDirectory === repositoryRoot) {
  throw new Error("Refusing to clean an unexpected TypeScript output directory");
}

rmSync(outputDirectory, { force: true, recursive: true });
execFileSync(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc")], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
