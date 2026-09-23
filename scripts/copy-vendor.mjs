// tsc only emits what it compiles, and the npm package and the standalone
// binary both ship dist/ alone, so vendored ESM has to be copied beside it.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(repoRoot, "src", "vendor");
const destination = path.join(repoRoot, "dist", "vendor");

await fs.rm(destination, { recursive: true, force: true });
await fs.cp(source, destination, { recursive: true });
