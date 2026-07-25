import { createAgentSession, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readLocalSdkManifest } from "../../pi/scripts/local-fork-fixture.mjs";

const manifestPath = process.argv[2];
if (manifestPath === undefined) throw new Error("Pi SDK manifest path is required");

const manifest = readLocalSdkManifest(manifestPath);
if (manifest.capabilities.modelRuntimeApiVersion !== 1) {
  throw new Error("Pi model runtime API version is not 1");
}

const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
if (typeof runtime.registerProvider !== "function") throw new Error("ModelRuntime.registerProvider missing");
if (typeof runtime.registerNativeProvider !== "function")
  throw new Error("ModelRuntime.registerNativeProvider missing");
if (typeof runtime.getModels !== "function") throw new Error("ModelRuntime.getModels missing");
if (typeof runtime.getAvailable !== "function") throw new Error("ModelRuntime.getAvailable missing");

const registry = new ModelRegistry(runtime);
if (typeof registry.getAvailable !== "function") throw new Error("ModelRegistry.getAvailable missing");
if (typeof registry.getRegisteredNativeProvider !== "function") {
  throw new Error("ModelRegistry.getRegisteredNativeProvider missing");
}

const { session } = await createAgentSession({ modelRuntime: runtime, cwd: process.cwd() });
session.dispose();
console.log(`Pi runtime capability probe passed for SDK ${manifest.sdkVersion}.`);
