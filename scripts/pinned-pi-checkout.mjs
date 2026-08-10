import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

export function preparePinnedPiCheckout(piDirectory, ref) {
  const source = resolve(piDirectory);
  const commit = git(source, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const head = git(source, ["rev-parse", "HEAD"]);
  const status = git(source, ["status", "--porcelain", "--untracked-files=all"]);
  if (head === commit && status.length === 0) {
    return { directory: source, commit, cleanup() {} };
  }

  const root = mkdtempSync(join(tmpdir(), "pi-pinned-source-"));
  const directory = join(root, "checkout");
  try {
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", source, directory], {
      stdio: "inherit",
    });
    execFileSync("git", ["-C", directory, "checkout", "--quiet", "--detach", commit], {
      stdio: "inherit",
    });
    return {
      directory,
      commit,
      cleanup() {
        rmSync(root, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

export async function createPinnedPiFixture(piDirectory, ref, prefix) {
  const pinned = preparePinnedPiCheckout(piDirectory, ref);
  try {
    const { createLocalForkFixture, installManifestSdk } = await import(
      pathToFileURL(join(pinned.directory, "scripts/local-fork-fixture.mjs")).href
    );
    const fixture = createLocalForkFixture({
      ref: pinned.commit,
      piDirectory: pinned.directory,
      prefix,
    });
    return {
      ...fixture,
      installManifestSdk,
      cleanupPinned: pinned.cleanup,
    };
  } catch (error) {
    pinned.cleanup();
    throw error;
  }
}
