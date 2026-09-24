// tsc only emits what it compiles, and the npm package and the standalone
// binary both ship dist/ alone, so non-TypeScript assets are copied beside it.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Each entry is copied to the same path under dist/.
const ASSET_DIRS = ["vendor", "personal-server/local/runtime-pkg"];

for (const relative of ASSET_DIRS) {
  const source = path.join(repoRoot, "src", relative);
  const destination = path.join(repoRoot, "dist", relative);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true });
}
