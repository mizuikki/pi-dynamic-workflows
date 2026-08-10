import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparePinnedPiCheckout } from "./pinned-pi-checkout.mjs";

const [outputDirectory, piDirectory, ref] = process.argv.slice(2);
if (!outputDirectory || !piDirectory || !ref) {
  throw new Error("Output directory, Pi checkout, and immutable ref are required");
}

const pinned = preparePinnedPiCheckout(piDirectory, ref);
try {
  const { prepareLocalForkFixture } = await import(
    pathToFileURL(resolve(pinned.directory, "scripts/local-fork-fixture.mjs")).href
  );
  prepareLocalForkFixture({
    out: outputDirectory,
    ref: pinned.commit,
    piDirectory: pinned.directory,
  });
} finally {
  pinned.cleanup();
}
