import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const expected = "acff3770ac8c30c896edd621996cf29a4761a0b993478659e4fa2cc445c7c2d5";
const suppliedPath = process.argv[2] ?? process.env.TRELLIS_TEMPLATE_PATH;

if (!suppliedPath) {
  throw new Error("Provide the Trellis 1.0.4 index.ts.txt path as an argument or TRELLIS_TEMPLATE_PATH.");
}

const templatePath = resolve(suppliedPath);
const actual = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
if (actual !== expected) {
  throw new Error(`Trellis 1.0.4 rendering oracle hash mismatch: expected ${expected}, got ${actual}.`);
}

process.stdout.write(`${JSON.stringify({ status: "PASS", templatePath, sha256: actual })}\n`);
