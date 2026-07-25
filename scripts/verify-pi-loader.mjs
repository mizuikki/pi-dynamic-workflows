import { discoverAndLoadExtensions } from "../../pi/packages/coding-agent/dist/index.js";

const [extensionPath, projectDirectory, agentDirectory] = process.argv.slice(2);
if (extensionPath === undefined || projectDirectory === undefined || agentDirectory === undefined) {
  throw new Error("Extension, project, and agent paths are required");
}

const result = await discoverAndLoadExtensions([extensionPath], projectDirectory, agentDirectory);
if (result.errors.length > 0 || result.extensions.length !== 1) {
  throw new Error(result.errors.map((entry) => entry.error).join("; "));
}
