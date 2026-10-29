import { execFileSync } from "node:child_process";
import fs from "node:fs";

const manifest = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match)
  throw new Error("Dev builds must start from a stable package version");
const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
  encoding: "utf8",
}).trim();
pkg.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-dev.${sha}`;
fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Dev CLI version: ${pkg.version}`);
