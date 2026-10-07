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

function npmName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * The npm that sits beside `node`, or none: a Node whose npm was removed or
 * broken (a half-finished `nvm install`, a stray uninstall) leaves the binary
 * without one.
 */
export class NpmMissingError extends Error {
  readonly nodePath: string;
  constructor(node: ResolvedNode, platform: NodeJS.Platform) {
    const version = node.version?.replace(/^v/, "");
    super(
      `npm is missing next to the Node at ${node.path} (no ${path.join(path.dirname(node.path), npmName(platform))}), and no npm on PATH runs either, so the Personal Server cannot be installed. ` +
        `Reinstall npm for that Node${version ? ` (with nvm: nvm install ${version})` : ""}, or set VANA_PDPP_NODE to a Node 24 binary that has npm beside it, then run vana server start again.`,
    );
    this.name = "NpmMissingError";
    this.nodePath = node.path;
  }
}

/** `npm ci` ran and failed; its output is in the install log. */
export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallError";
  }
}

export interface RuntimeInstallDeps {
  exec: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      maxBuffer?: number;
      windowsHide?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function defaultInstallDeps(): RuntimeInstallDeps {
  return {
    exec: async (file, args, options) => {
      const { stdout, stderr } = await execFileAsync(file, args, options);
      return { stdout: String(stdout), stderr: String(stderr) };
    },
    env: process.env,
    platform: process.platform,
  };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where to look for npm: beside the Node first, since a Node release keeps
 * its npm there and that npm builds native modules for the Node that will
 * load them; then PATH, which runs under the same Node (it leads PATH).
 */
function npmCandidates(node: ResolvedNode, deps: RuntimeInstallDeps): string[] {
  const name = npmName(deps.platform);
  const beside = path.join(path.dirname(node.path), name);
  const onPath = (deps.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, name));
  return [...new Set([beside, ...onPath])].filter(isFile);
}

/** An error from starting the process, not from the process failing. */
function isSpawnError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    typeof code === "string" &&
    ["ENOENT", "EACCES", "ENOEXEC", "EPERM"].includes(code)
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
  overrides: Partial<RuntimeInstallDeps> = {},
): Promise<string> {
  const deps = { ...defaultInstallDeps(), ...overrides };
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
  const env = {
    ...deps.env,
    PATH: `${path.dirname(node.path)}${path.delimiter}${deps.env.PATH ?? ""}`,
  };
  let installed = false;
  for (const npm of npmCandidates(node, deps)) {
    await fsp.appendFile(logPath, `${npm} ci in ${dir}\n`, "utf8");
    try {
      const { stdout, stderr } = await deps.exec(
        npm,
        ["ci", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: dir, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      );
      await fsp.appendFile(logPath, `${stdout}${stderr}`, "utf8");
      installed = true;
      break;
    } catch (error) {
      if (isSpawnError(error)) {
        // A dangling link or a script whose interpreter is gone: try the next.
        await fsp.appendFile(
          logPath,
          `${npm} did not start: ${(error as Error).message}\n`,
          "utf8",
        );
        continue;
      }
      const failed = error as { stdout?: unknown; stderr?: unknown };
      await fsp.appendFile(
        logPath,
        `${String(failed.stdout ?? "")}${String(failed.stderr ?? "")}\n`,
        "utf8",
      );
      throw new RuntimeInstallError(
        `Installing the Personal Server failed (npm ci). See ${logPath}.`,
      );
    }
  }
  if (!installed) {
    const missing = new NpmMissingError(node, deps.platform);
    await fsp.appendFile(logPath, `${missing.message}\n`, "utf8");
    throw missing;
  }

  try {
    await deps.exec(
      node.path,
      ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
      { cwd: dir, env, windowsHide: true },
    );
  } catch (error) {
    await fsp.appendFile(
      logPath,
      `${error instanceof Error ? error.message : String(error)}\n`,
      "utf8",
    );
    throw new RuntimeInstallError(
      `The Personal Server installed, but its database module does not load under ${node.path}. See ${logPath}.`,
    );
  }
  await fsp.writeFile(
    path.join(dir, ".installed"),
    `${lockHash(assetDir())}\n`,
    "utf8",
  );
  return dir;
}
