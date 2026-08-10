import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPinnedPiFixture } from "./pinned-pi-checkout.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piForkDirectory = resolve(process.env.PI_FORK_DIR ?? join(repositoryRoot, "../pi"));
const piForkRef = process.env.PI_FORK_REF ?? "769eaaba2ead3e9153d4460dd64b040f9703a9f8";
const keepTemp = process.env.KEEP_TEMP === "1";
function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function configuredSources(projectDirectory) {
  const settings = JSON.parse(readFileSync(join(projectDirectory, ".pi/settings.json"), "utf8"));
  return (settings.packages ?? []).map((entry) => (typeof entry === "string" ? entry : entry.source));
}

const fixture = await createPinnedPiFixture(piForkDirectory, piForkRef, "pi-workflow-local-install-");
let passed = false;

try {
  fixture.installManifestSdk(fixture.projectDirectory, fixture.manifest);
  const cliEntry = join(fixture.projectDirectory, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const sdkEntry = join(fixture.projectDirectory, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const agentDirectory = join(fixture.root, "agent");
  const commandEnvironment = { ...process.env, PI_CODING_AGENT_DIR: agentDirectory };

  run(process.execPath, [cliEntry, "install", "-l", repositoryRoot, "--approve"], {
    cwd: fixture.projectDirectory,
    env: commandEnvironment,
  });
  if (configuredSources(fixture.projectDirectory).length !== 1) {
    throw new Error("Local install did not persist exactly one project package source");
  }

  run(
    process.execPath,
    [
      join(repositoryRoot, "scripts/verify-local-install-loader.mjs"),
      sdkEntry,
      fixture.projectDirectory,
      agentDirectory,
      repositoryRoot,
    ],
    { cwd: fixture.projectDirectory, env: commandEnvironment },
  );

  run(process.execPath, [cliEntry, "remove", repositoryRoot, "-l", "--approve"], {
    cwd: fixture.projectDirectory,
    env: commandEnvironment,
  });
  if (configuredSources(fixture.projectDirectory).length !== 0) {
    throw new Error("Local remove left a project package source configured");
  }

  passed = true;
  console.log(`Local install/load/remove passed at ${fixture.manifest.forkCommit}.`);
} finally {
  if (passed || !keepTemp) {
    rmSync(fixture.root, { force: true, recursive: true });
  } else {
    console.error(`Local install smoke failed; temporary directory retained at ${fixture.root}`);
  }
  fixture.cleanupPinned();
}
