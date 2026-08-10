import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piForkDirectory = resolve(process.env.PI_FORK_DIR ?? join(projectDirectory, "../pi"));
const { createManifestConsumer, readLocalSdkManifest } = await import(
  pathToFileURL(join(piForkDirectory, "scripts/local-fork-fixture.mjs")).href
);

const [manifestPath, consumerDirectory, tarball] = process.argv.slice(2);
if (manifestPath === undefined || consumerDirectory === undefined || tarball === undefined) {
  throw new Error("Manifest, consumer directory, and package tarball are required");
}

createManifestConsumer(consumerDirectory, readLocalSdkManifest(manifestPath), {
  "@mizuikki/pi-workflow-orchestrator": `file:${tarball}`,
  typebox: "1.3.7",
  typescript: "latest",
});
