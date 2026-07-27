import { resolve } from "node:path";
import { discoverAndLoadExtensions } from "../../pi/packages/coding-agent/dist/index.js";

const [extensionPath, projectDirectory, agentDirectory] = process.argv.slice(2);
if (extensionPath === undefined || projectDirectory === undefined || agentDirectory === undefined) {
  throw new Error("Extension, project, and agent paths are required");
}

const result = await discoverAndLoadExtensions([extensionPath], projectDirectory, agentDirectory);
const requested = resolve(extensionPath);
const matching = result.extensions.filter(
  (extension) => resolve(extension.resolvedPath ?? extension.path) === requested,
);
if (result.errors.length > 0 || matching.length !== 1) {
  const details = result.errors.map((entry) => {
    const error = entry.error;
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
  });
  throw new Error([...details, `requested extension match count: ${matching.length} (expected 1)`].join("; "));
}
