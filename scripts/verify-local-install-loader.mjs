import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sdkEntry, projectDirectory, agentDirectory, sourceDirectory] = process.argv.slice(2);
if (!sdkEntry || !projectDirectory || !agentDirectory || !sourceDirectory) {
  throw new Error("SDK entry, project, agent, and source directories are required");
}

const { DefaultResourceLoader } = await import(pathToFileURL(resolve(sdkEntry)).href);
const loader = new DefaultResourceLoader({
  cwd: resolve(projectDirectory),
  agentDir: resolve(agentDirectory),
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();

const result = loader.getExtensions();
const expected = resolve(sourceDirectory, "extensions/workflow.ts");
const matches = result.extensions.filter((extension) => resolve(extension.resolvedPath ?? extension.path) === expected);
if (result.errors.length > 0 || matches.length !== 1) {
  const details = result.errors.map((entry) => {
    const error = entry.error;
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
  });
  throw new Error([...details, `installed extension match count: ${matches.length} (expected 1)`].join("; "));
}

console.log("Local package source loaded once through the real Pi resource loader.");
