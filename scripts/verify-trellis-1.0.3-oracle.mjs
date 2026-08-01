import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const expected = "c3bc03d5f3d6ee0ed2bd93c73344f95b0ac01217a515ea602af8d978398b2fcb";
const suppliedPath = process.argv[2] ?? process.env.TRELLIS_TEMPLATE_PATH;

if (!suppliedPath) {
  throw new Error("Provide the Trellis 1.0.3 index.ts.txt path as an argument or TRELLIS_TEMPLATE_PATH.");
}

const templatePath = resolve(suppliedPath);
const actual = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
if (actual !== expected) {
  throw new Error(`Trellis 1.0.3 rendering oracle hash mismatch: expected ${expected}, got ${actual}.`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", templatePath, sha256: actual })}\n`);
