import { createManifestConsumer, readLocalSdkManifest } from "../../pi/scripts/local-fork-fixture.mjs";

const [manifestPath, consumerDirectory, tarball] = process.argv.slice(2);
if (manifestPath === undefined || consumerDirectory === undefined || tarball === undefined) {
  throw new Error("Manifest, consumer directory, and package tarball are required");
}

createManifestConsumer(consumerDirectory, readLocalSdkManifest(manifestPath), {
  "@quintinshaw/pi-dynamic-workflows": `file:${tarball}`,
  typebox: "latest",
  typescript: "latest",
});
