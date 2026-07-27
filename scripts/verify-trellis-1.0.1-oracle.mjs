import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const expected = "bf6069795ba5fbbad0b8bc95f6ee66154e31bd3d1c01d7825dc9fb6cc19e5ec5";
const suppliedPath = process.argv[2] ?? process.env.TRELLIS_TEMPLATE_PATH;

if (!suppliedPath) {
  throw new Error("Provide the Trellis 1.0.1 index.ts.txt path as an argument or TRELLIS_TEMPLATE_PATH.");
}

const templatePath = resolve(suppliedPath);
const actual = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
if (actual !== expected) {
  throw new Error(`Trellis 1.0.1 rendering oracle hash mismatch: expected ${expected}, got ${actual}.`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", templatePath, sha256: actual })}\n`);
