import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import * as tar from "tar";

import { getVanaHome } from "../core/paths.js";
import { getSystemChromePath } from "../runtime/playwright/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** Everything the CLI keeps for Collection Profile connectors. */
export function getPdppHome(): string {
  return path.join(getVanaHome(), "pdpp");
}

/**
 * The Node release installed when no compatible one is found. It matches the
 * runtime Vana Desktop bundles, and the checksums are the official
 * SHASUMS256.txt values, so a download is checked against a hash that
 * shipped with the CLI rather than one fetched next to the tarball.
 */
export const PDPP_NODE_VERSION = "24.21.0";
const PDPP_NODE_SHA256: Record<string, string> = {
  "darwin-arm64":
    "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  "darwin-x64":
    "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
  "linux-arm64":
    "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
  "linux-x64":
    "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
};

/** What a signed artifact's provenance asks of the machine running it. */
export interface HostRuntimeContract {
  node: string;
  packages: Array<{ package: string; declared_version: string }>;
}

type Version = [number, number, number];

function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether `version` satisfies a space-separated comparator range such as
 * `>=24.15.0 <25`, the only form artifact provenance uses. Anything the
 * parser does not understand fails closed.
 */
export function satisfiesNodeRange(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual) return false;
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
    const bound = match ? parseVersion(match[2]) : null;
    if (!match || !bound) return false;
    const order = compareVersions(actual, bound);
    switch (match[1] ?? "=") {
      case ">=":
        return order >= 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case "<":
        return order < 0;
      default:
        return order === 0;
    }
  });
}

async function readNodeVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    // A standalone vana binary answers --version with its own version, which
    // parses but is not a Node release; only a `v`-prefixed line is Node.
    const line = stdout.trim();
    return /^v\d+\.\d+\.\d+$/.test(line) ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function nodeBinaryName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function managedNodeDir(): string {
  return path.join(getPdppHome(), "node", PDPP_NODE_VERSION);
}

function managedNodeBinary(): string {
  return process.platform === "win32"
    ? path.join(managedNodeDir(), nodeBinaryName())
    : path.join(managedNodeDir(), "bin", nodeBinaryName());
}

function candidateNodeBinaries(): string[] {
  const candidates: string[] = [];
  if (process.env.VANA_PDPP_NODE) candidates.push(process.env.VANA_PDPP_NODE);
  candidates.push(managedNodeBinary());
  candidates.push(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, nodeBinaryName()));
  }
  // nvm installs are usually not on PATH for a version other than the
  // current default, which is exactly the version a connector may need.
  const nvmVersions = path.join(
    process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm"),
    "versions",
    "node",
  );
  try {
    for (const entry of fs.readdirSync(nvmVersions).sort().reverse()) {
      candidates.push(path.join(nvmVersions, entry, "bin", nodeBinaryName()));
    }
  } catch {
    // No nvm.
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export interface ResolvedNode {
  path: string;
  version: string;
}

function readNodeVersionSync(binary: string): string | null {
  try {
    const line = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^v\d+\.\d+\.\d+$/.test(line) ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** Synchronous {@link findCompatibleNode}, for status checks that cannot await. */
export function findCompatibleNodeSync(range: string): ResolvedNode | null {
  for (const candidate of candidateNodeBinaries()) {
    if (!fs.existsSync(candidate)) continue;
    const version = readNodeVersionSync(candidate);
    if (version && satisfiesNodeRange(version, range)) {
      return { path: candidate, version };
    }
  }
  return null;
}

/**
 * A Node binary on this machine that satisfies `range`, or null.
 *
 * `VANA_PDPP_NODE` wins when it satisfies the range; a standalone vana
 * binary's own Node cannot run a script, so every candidate is asked for its
 * version rather than trusted from `process.version`.
 */
export async function findCompatibleNode(
  range: string,
): Promise<ResolvedNode | null> {
  for (const candidate of candidateNodeBinaries()) {
    if (!fs.existsSync(candidate)) continue;
    const version = await readNodeVersion(candidate);
    if (version && satisfiesNodeRange(version, range)) {
      return { path: candidate, version };
    }
  }
  return null;
}

/** Whether the pinned Node release this CLI can install satisfies `range`. */
export function canInstallNodeFor(range: string): boolean {
  return (
    satisfiesNodeRange(PDPP_NODE_VERSION, range) &&
    Boolean(PDPP_NODE_SHA256[`${process.platform}-${process.arch}`])
  );
}

/**
 * Download the pinned Node release into ~/.vana/pdpp/node and check it
 * against the checksum compiled into the CLI before anything is unpacked.
 */
export async function installManagedNode(
  logPath: string,
): Promise<ResolvedNode> {
  const platformKey = `${process.platform}-${process.arch}`;
  const expected = PDPP_NODE_SHA256[platformKey];
  if (!expected) {
    throw new Error(
      `No Node ${PDPP_NODE_VERSION} build is pinned for ${platformKey}. Install Node 24 yourself and set VANA_PDPP_NODE to its path.`,
    );
  }
  const archiveName = `node-v${PDPP_NODE_VERSION}-${platformKey}.tar.gz`;
  const url = `https://nodejs.org/dist/v${PDPP_NODE_VERSION}/${archiveName}`;
  await fsp.appendFile(logPath, `Downloading ${url}\n`, "utf8");

  const response = await fetch(url, { headers: { "User-Agent": "vana-cli" } });
  if (!response.ok) {
    throw new Error(
      `Could not download Node ${PDPP_NODE_VERSION}: ${response.status}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Node ${PDPP_NODE_VERSION} download failed its checksum (expected ${expected}, got ${actual}).`,
    );
  }

  const parent = path.dirname(managedNodeDir());
  await fsp.mkdir(parent, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parent, ".staging-"));
  try {
    const archivePath = path.join(staging, archiveName);
    await fsp.writeFile(archivePath, archive);
    await tar.x({ file: archivePath, cwd: staging, strip: 1 });
    await fsp.rm(archivePath, { force: true });
    await fsp.rm(managedNodeDir(), { recursive: true, force: true });
    await fsp.rename(staging, managedNodeDir());
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
  await fsp.appendFile(
    logPath,
    `Installed Node into ${managedNodeDir()}\n`,
    "utf8",
  );

  const version = await readNodeVersion(managedNodeBinary());
  if (!version) {
    throw new Error(`Installed Node at ${managedNodeBinary()} does not run.`);
  }
  return { path: managedNodeBinary(), version };
}

/**
 * Make each host package an artifact declares resolvable from its install
 * root, at exactly the declared version.
 *
 * A signed artifact leaves its browser driver out and loads it by dynamic
 * import, and ESM resolution ignores NODE_PATH, so the package has to sit in
 * a `node_modules` directory above the artifact. The CLI ships the pinned
 * version and links it there rather than installing a second copy.
 */
export async function linkHostPackages(
  installRoot: string,
  contract: HostRuntimeContract,
): Promise<void> {
  const nodeModules = path.join(installRoot, "node_modules");
  await fsp.mkdir(nodeModules, { recursive: true });
  for (const declared of contract.packages) {
    let packageRoot: string;
    try {
      packageRoot = path.dirname(
        require.resolve(`${declared.package}/package.json`),
      );
    } catch {
      throw new Error(
        `This connector needs ${declared.package} ${declared.declared_version}, which this build of vana does not include.`,
      );
    }
    const { version } = JSON.parse(
      await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version: string };
    if (version !== declared.declared_version) {
      throw new Error(
        `This connector needs ${declared.package} ${declared.declared_version}, but vana includes ${version}. Update vana.`,
      );
    }

    const link = path.join(nodeModules, declared.package);
    await fsp.rm(link, { recursive: true, force: true });
    await fsp.symlink(
      packageRoot,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

/** Where connector browser profiles live; owned by the CLI, never shared. */
export function getPdppProfileRoot(): string {
  return path.join(getPdppHome(), "profiles");
}

function patchrightBrowsersDir(): string {
  return path.join(getPdppHome(), "browsers");
}

/**
 * Environment that decides which browser a connector launches.
 *
 * System Chrome is preferred for the same reason the legacy runtime prefers
 * it: sites treat it as a normal browser. Without it the connector's own
 * patchright Chromium is used, installed once under ~/.vana/pdpp/browsers.
 */
export function browserEnvironment(): Record<string, string> {
  if (getSystemChromePath()) {
    return { PDPP_BROWSER_CHANNEL: "chrome" };
  }
  return { PLAYWRIGHT_BROWSERS_PATH: patchrightBrowsersDir() };
}

export async function ensureConnectorBrowser(
  node: ResolvedNode,
  logPath: string,
): Promise<void> {
  if (getSystemChromePath()) return;
  const cliPath = path.join(
    path.dirname(require.resolve("patchright/package.json")),
    "cli.js",
  );
  await fsp.appendFile(logPath, "Installing Chromium for patchright\n", "utf8");
  const { stdout, stderr } = await execFileAsync(
    node.path,
    [cliPath, "install", "chromium"],
    {
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: patchrightBrowsersDir(),
      },
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  await fsp.appendFile(logPath, `${stdout}${stderr}`, "utf8");
}
