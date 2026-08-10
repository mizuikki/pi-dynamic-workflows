import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = [
  "src",
  "extensions",
  "scripts",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs",
  "package.json",
];

const forbidden = [
  ["old package identity", /@quintinshaw\/pi-dynamic-workflows/g],
  ["old repository URL", /(?:https?:\/\/|git\+https:\/\/)github\.com\/QuintinShaw\/pi-dynamic-workflows/g],
  ["old website URL", /https?:\/\/quintinshaw\.github\.io\/pi-dynamic-workflows\/?/g],
  ["old host ABI", /pi-dynamic-workflows-host\/v1/g],
  ["old state root", /\.pi\/workflows|workflows\.sqlite3/g],
  ["old database application id", /1346656070/g],
  [
    "legacy root command registration",
    /registerCommand\(["'](?:workflows|workflows-models|workflows-trigger|workflows-progress|workflows-progress-max|workflows-prompt|effort|ultracode)["']/g,
  ],
  ["legacy workflow subcommand", /\/workflow (?:models|effort)(?:\s|`|$)/g],
  [
    "legacy plural workflow command",
    /(?<![\w/])\/workflows(?:-models|-progress|-trigger|-prompt|-progress-max)?(?:\s|`|$|[.,;)])/g,
  ],
  ["invalid workflow mode image", /workflow-mode\.jpg/g],
  [
    "human workflow gate",
    /CheckpointOptions|const checkpoint|checkpoint,|options\.confirm|ui\.confirm|Workflow checkpoint|waiting_for_approval|launch consent|ToolEffectPolicy|toolEffects/g,
  ],
  ["fixed scenario or bundled Web registration", /registerBuiltinWorkflows|createWebTools|web_search|web_fetch/g],
  ["model tier", /model-tier|ModelTier|small[^\n]*medium[^\n]*big/g],
  ["old Trellis contract", /SUPPORTED_TRELLIS_PROJECT_VERSION\s*=\s*["']1\.0\.3["']|trellis-1\.0\.3/g],
];

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...scanRoots], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((path) => existsSync(join(repositoryRoot, path)))
  .filter((path) => path !== "scripts/verify-product-boundary.mjs");

const failures = [];
const sources = new Map();
for (const path of tracked) {
  const content = readFileSync(join(repositoryRoot, path), "utf8");
  sources.set(path, content);
  for (const [label, pattern] of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) failures.push(`${label}: ${path}`);
  }
}

const combined = [...sources.values()].join("\n");
for (const [label, pattern] of [
  ["current repository URL", /github\.com\/mizuikki\/pi-dynamic-workflows/],
  ["current README media path", /docs\/media\/workflows-mode\.jpg/],
  ["local architecture reference", /docs\/architecture\.md/],
  ["singular workflow model command", /\/workflow model/],
  ["workflow intensity command", /\/workflow intensity/],
  ["Pi thinking capability lookup", /getSupportedThinkingLevels/],
  ["Pi thinking-level clamp", /clampThinkingLevel/],
  ["Trellis 1.0.4", /SUPPORTED_TRELLIS_PROJECT_VERSION\s*=\s*["']1\.0\.4["']/],
  ["conditional Trellis tool", /trellis_subagent/],
  ["new Keel ABI", /pi-workflow-orchestrator-host\/v1/],
]) {
  if (!pattern.test(combined)) failures.push(`missing retained contract: ${label}`);
}

for (const [path, content] of sources) {
  if (!path.endsWith(".md")) continue;
  const markdownLinks = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (let match = markdownLinks.exec(content); match; match = markdownLinks.exec(content)) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
    const localTarget = target.split("#", 1)[0];
    if (localTarget && !existsSync(resolve(dirname(join(repositoryRoot, path)), localTarget))) {
      failures.push(`broken local Markdown link: ${path} -> ${target}`);
    }
  }
}

const packageDirectory = mkdtempSync(join(tmpdir(), "pi-workflow-package-boundary-"));
try {
  const packPayload = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--loglevel=error", "--pack-destination", packageDirectory],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ),
  );
  const packResult = Array.isArray(packPayload) ? packPayload[0] : Object.values(packPayload)[0];
  if (!packResult || typeof packResult.filename !== "string") {
    throw new Error("npm pack did not return package metadata");
  }
  const tarball = join(packageDirectory, packResult.filename);
  const entries = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const requiredEntries = [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/extensions/workflow.ts",
    "package/docs/architecture.md",
    "package/docs/storage.md",
    "package/docs/media/demo.gif",
    "package/docs/media/workflows-mode.jpg",
    "package/README.md",
  ];
  for (const entry of requiredEntries) {
    if (!entries.includes(entry)) failures.push(`package output is missing ${entry}`);
  }
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("../")) failures.push(`unsafe package path: ${entry}`);
    if (/\/(?:tests|scripts|\.trellis|\.pi)\//.test(entry)) failures.push(`private build input packaged: ${entry}`);
    if (/adversarial-review|builtin-commands|code-review|deep-research|web-tools/.test(entry)) {
      failures.push(`deleted product surface packaged: ${entry}`);
    }
  }

  execFileSync("tar", ["-xf", tarball, "-C", packageDirectory]);
  const textEntries = entries.filter((entry) => /\.(?:js|ts|json|md)$/.test(entry));
  for (const entry of textEntries) {
    const content = readFileSync(join(packageDirectory, entry), "utf8");
    if (
      content.includes(repositoryRoot) ||
      /\/home\/[A-Za-z0-9._-]+\//.test(content) ||
      /\/Users\/[A-Za-z0-9._-]+\//.test(content)
    ) {
      failures.push(`local path leaked into package output: ${entry}`);
    }
  }
} finally {
  rmSync(packageDirectory, { force: true, recursive: true });
}

if (failures.length > 0) {
  throw new Error(
    `Product boundary verification failed:\n${[...new Set(failures)].map((entry) => `- ${entry}`).join("\n")}`,
  );
}

console.log(`Product boundary passed across ${tracked.length} source files and the packed artifact.`);
