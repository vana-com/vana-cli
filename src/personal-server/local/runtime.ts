import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ResolvedNode } from "../../pdpp/host.js";
import { localServerRuntimeDir } from "./config.js";

const execFileAsync = promisify(execFile);

/** The scripts the server process runs; they change with the CLI, not the pin. */
const SCRIPT_FILES = [
  "entry.mjs",
  "derived-config.mjs",
  "mcp-approval.mjs",
] as const;

/** Files shipped with the CLI that define the runtime: the pin, its lock, the scripts. */
const ASSET_FILES = [
  "package.json",
  "package-lock.json",
  ...SCRIPT_FILES,
] as const;

function assetDir(): string {
  return fileURLToPath(new URL("./runtime-pkg/", import.meta.url));
}

function lockHash(dir: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(dir, "package-lock.json")))
    .digest("hex");
}

function npmFor(node: ResolvedNode): string {
  // A Node release keeps npm beside the binary; using that npm means the
  // native modules are built for the Node that will load them.
  return path.join(
    path.dirname(node.path),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
}

export function isRuntimeInstalled(dir = localServerRuntimeDir()): boolean {
  try {
    return (
      fs.readFileSync(path.join(dir, ".installed"), "utf8").trim() ===
        lockHash(assetDir()) &&
      fs.existsSync(
        path.join(dir, "node_modules", "@opendatalabs", "personal-server-ts"),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Install the pinned Personal Server into its versioned dir with `npm ci`, so
 * every install resolves to the same dependency tree, then prove the native
 * module loads under the Node that will run it.
 */
export async function ensureRuntime(
  node: ResolvedNode,
  logPath: string,
  dir = localServerRuntimeDir(),
): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  // The scripts change with the CLI, not with the pin: refresh them always.
  for (const file of SCRIPT_FILES) {
    await fsp.copyFile(path.join(assetDir(), file), path.join(dir, file));
  }
  if (isRuntimeInstalled(dir)) {
    return dir;
  }

  for (const file of ASSET_FILES) {
    await fsp.copyFile(path.join(assetDir(), file), path.join(dir, file));
  }
  await fsp.rm(path.join(dir, "node_modules"), {
    recursive: true,
    force: true,
  });
  await fsp.appendFile(logPath, `npm ci in ${dir}\n`, "utf8");
  const env = {
    ...process.env,
    PATH: `${path.dirname(node.path)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const { stdout, stderr } = await execFileAsync(
    npmFor(node),
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: dir, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  await fsp.appendFile(logPath, `${stdout}${stderr}`, "utf8");

  await execFileAsync(
    node.path,
    ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
    { cwd: dir, env, windowsHide: true },
  );
  await fsp.writeFile(
    path.join(dir, ".installed"),
    `${lockHash(assetDir())}\n`,
    "utf8",
  );
  return dir;
}
