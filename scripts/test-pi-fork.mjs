import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPinnedPiFixture } from "./pinned-pi-checkout.mjs";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piForkDirectory = resolve(process.env.PI_FORK_DIR ?? join(projectDirectory, "../pi"));
const piForkRef = process.env.PI_FORK_REF ?? "HEAD";
const keepTemp = process.env.KEEP_TEMP === "1";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function copyProject(destination) {
  const archive = join(dirname(destination), "project.tar");
  run("tar", [
    "--exclude=./node_modules",
    "--exclude=./dist",
    "--exclude=./.git",
    "--exclude=./.worktrees",
    "-C",
    projectDirectory,
    "-cf",
    archive,
    ".",
  ]);
  run("tar", ["-xf", archive, "-C", destination]);
  rmSync(archive, { force: true });
}

if (!existsSync(join(piForkDirectory, ".git"))) {
  throw new Error(`PI_FORK_DIR is not a git checkout: ${piForkDirectory}`);
}

const fixture = await createPinnedPiFixture(piForkDirectory, piForkRef, "pi-local-fork-");
let passed = false;

try {
  copyProject(fixture.projectDirectory);
  // The helper creates <temp>/pi before npm resolves file:../pi development dependencies.
  run(npm, ["ci", "--ignore-scripts", "--prefix", fixture.projectDirectory]);
  fixture.installManifestSdk(fixture.projectDirectory, fixture.manifest);
  run(npm, ["run", "check", "--prefix", fixture.projectDirectory]);
  run(npm, ["run", "build", "--prefix", fixture.projectDirectory]);
  run(npm, ["run", "test:unit", "--prefix", fixture.projectDirectory]);

  run(
    process.execPath,
    [join(fixture.projectDirectory, "scripts/verify-pi-runtime-capabilities.mjs"), fixture.manifestPath],
    {
      cwd: fixture.projectDirectory,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(fixture.root, "agent"),
      },
    },
  );

  for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    const packageDirectory = join(fixture.projectDirectory, "node_modules", packageName);
    rmSync(packageDirectory, { force: true, recursive: true });
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify({ name: packageName, type: "module" })}\n`);
    writeFileSync(
      join(packageDirectory, "index.js"),
      `throw new Error(${JSON.stringify(`poison package imported: ${packageName}`)});\n`,
    );
  }

  run(
    process.execPath,
    [
      join(fixture.projectDirectory, "scripts/verify-pi-loader.mjs"),
      join(fixture.projectDirectory, "extensions/workflow.ts"),
      fixture.projectDirectory,
      join(fixture.root, "agent"),
    ],
    { cwd: fixture.projectDirectory },
  );

  passed = true;
  console.log(`Pi ModelRuntime contract passed at ${fixture.manifest.forkCommit}.`);
} finally {
  if (passed || !keepTemp) {
    rmSync(fixture.root, { force: true, recursive: true });
  } else {
    console.error(`Pi fork verification failed; temporary directory retained at ${fixture.root}`);
  }
  fixture.cleanupPinned();
}
