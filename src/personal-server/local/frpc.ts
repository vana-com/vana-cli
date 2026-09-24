import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as tar from "tar";

import { localServerHome } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * The tunnel client the Personal Server runs to get its public URL. Same
 * version the pinned server would download for itself.
 */
export const FRPC_VERSION = "0.67.0";

/** The Apple team that signs the CLI and Vana Desktop. */
export const VANA_APPLE_TEAM_ID = "G7QNBSSW44";

interface FrpcArtifact {
  url: string;
  sha256: string;
  /** The binary's path inside the archive. */
  entry: string;
}

function upstream(name: string, ext: string, sha256: string): FrpcArtifact {
  const base = `frp_${FRPC_VERSION}_${name}`;
  return {
    url: `https://github.com/fatedier/frp/releases/download/v${FRPC_VERSION}/${base}.${ext}`,
    sha256,
    entry: `${base}/${name.startsWith("windows") ? "frpc.exe" : "frpc"}`,
  };
}

function signed(name: string, sha256: string): FrpcArtifact {
  const base = `frp_${FRPC_VERSION}_${name}`;
  return {
    url: `https://github.com/vana-com/vana-cli/releases/download/frpc-v${FRPC_VERSION}/${base}.tar.gz`,
    sha256,
    entry: `${base}/frpc`,
  };
}

/**
 * Pinned downloads per platform. A Mac never gets upstream's build: it is
 * ad-hoc signed, and endpoint security on managed Macs treats an ad-hoc
 * binary run from the home directory as persistence. Macs download the copy
 * the sign-frpc workflow signed and notarized with Vana's Developer ID.
 */
export const FRPC_ARTIFACTS: Record<string, FrpcArtifact> = {
  "darwin-arm64": signed(
    "darwin_arm64",
    "e0a45a02b8be7d2e0e3221b1e1deb242b490a1e6a685beeff04bcd96cb42a9f1",
  ),
  "darwin-x64": signed(
    "darwin_amd64",
    "106f023c440b395cf7d21283536a87156c69f26ebf40fd0084f11fc01de8f6a4",
  ),
  "linux-x64": upstream(
    "linux_amd64",
    "tar.gz",
    "f8629ca7ca56b8e7e7a9903779b8d5c47c56ad1b75b99b2d7138477acc4c7105",
  ),
  "linux-arm64": upstream(
    "linux_arm64",
    "tar.gz",
    "0e9683226acdcbbb2ac8d073f35ba8be2a8b1e7584684d2073f39d337ebd6de7",
  ),
  "win32-x64": upstream(
    "windows_amd64",
    "zip",
    "8baf23e3fbd486f6ba0913501372c5ff0053efa88a8b8d391f3605ced43d2af5",
  ),
};

/** Where Vana Desktop ships its signed frpc. */
export const DESKTOP_FRPC_PATHS = [
  "/Applications/Vana.app/Contents/Resources/personal-server/dist/frpc",
  path.join(
    os.homedir(),
    "Applications/Vana.app/Contents/Resources/personal-server/dist/frpc",
  ),
];

export type FrpcResolution =
  | { kind: "ready"; path: string; source: "env" | "managed" | "desktop" }
  | { kind: "installable" }
  | { kind: "unavailable"; reason: string };

export interface FrpcDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  managedDir: string;
  desktopPaths: string[];
  /** True when `file` carries a valid signature from `teamId`. */
  signedByTeam: (file: string, teamId: string) => Promise<boolean>;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "frpc.exe" : "frpc";
}

export function managedFrpcDir(): string {
  return path.join(localServerHome(), "frpc", FRPC_VERSION);
}

export async function signedByTeam(
  file: string,
  teamId: string,
): Promise<boolean> {
  try {
    await execFileAsync("codesign", ["--verify", "--strict", file]);
    // `codesign -dv` reports on stderr.
    const { stderr } = await execFileAsync("codesign", ["-dv", file]);
    return new RegExp(`^TeamIdentifier=${teamId}$`, "m").test(stderr);
  } catch {
    return false;
  }
}

function defaultDeps(): FrpcDeps {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    managedDir: managedFrpcDir(),
    desktopPaths: DESKTOP_FRPC_PATHS,
    signedByTeam,
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
 * Find a tunnel client this machine may run, without downloading anything.
 * `VANA_FRPC_PATH` wins; then the CLI's own verified install; then, on a
 * Mac, Vana Desktop's copy when it carries Vana's signature, which saves a
 * download.
 */
export async function resolveFrpc(
  overrides: Partial<FrpcDeps> = {},
): Promise<FrpcResolution> {
  const deps = { ...defaultDeps(), ...overrides };
  const fromEnv = deps.env.VANA_FRPC_PATH;
  if (fromEnv) {
    return isFile(fromEnv)
      ? { kind: "ready", path: fromEnv, source: "env" }
      : {
          kind: "unavailable",
          reason: `VANA_FRPC_PATH (${fromEnv}) is not a file.`,
        };
  }

  const artifact = FRPC_ARTIFACTS[`${deps.platform}-${deps.arch}`];
  const managed = path.join(deps.managedDir, binaryName(deps.platform));
  if (artifact && isFile(managed)) {
    try {
      const marker = fs
        .readFileSync(path.join(deps.managedDir, ".installed"), "utf8")
        .trim();
      if (marker === artifact.sha256) {
        return { kind: "ready", path: managed, source: "managed" };
      }
    } catch {
      // No marker: reinstall.
    }
  }

  if (deps.platform === "darwin") {
    for (const candidate of deps.desktopPaths) {
      if (
        isFile(candidate) &&
        (await deps.signedByTeam(candidate, VANA_APPLE_TEAM_ID))
      ) {
        return { kind: "ready", path: candidate, source: "desktop" };
      }
    }
  }

  if (artifact) return { kind: "installable" };
  return {
    kind: "unavailable",
    reason: `No tunnel client is pinned for ${deps.platform}-${deps.arch}. Set VANA_FRPC_PATH.`,
  };
}

/**
 * Download the pinned frpc for this platform, check its sha256, and install
 * it under ~/.vana/cli/personal-server/frpc/<version>.
 */
export async function installFrpc(
  logPath: string,
  overrides: Partial<FrpcDeps> & { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const deps = { ...defaultDeps(), ...overrides };
  const key = `${deps.platform}-${deps.arch}`;
  const artifact = FRPC_ARTIFACTS[key];
  if (!artifact) {
    throw new Error(`No tunnel client is pinned for ${key}.`);
  }
  await fsp.appendFile(logPath, `Downloading ${artifact.url}\n`, "utf8");
  const response = await (overrides.fetchImpl ?? fetch)(artifact.url, {
    headers: { "User-Agent": "vana-cli" },
  });
  if (!response.ok) {
    throw new Error(`Could not download the tunnel client: ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(
      `The tunnel client download failed its checksum (expected ${artifact.sha256}, got ${actual}).`,
    );
  }

  const parent = path.dirname(deps.managedDir);
  await fsp.mkdir(parent, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parent, ".staging-"));
  try {
    const archivePath = path.join(staging, path.basename(artifact.url));
    await fsp.writeFile(archivePath, archive);
    if (artifact.url.endsWith(".zip")) {
      // Windows 10+ ships a bsdtar that reads zip.
      await execFileAsync("tar", ["-xf", archivePath, "-C", staging]);
    } else {
      await tar.x({ file: archivePath, cwd: staging });
    }
    const installed = path.join(staging, "out");
    await fsp.mkdir(installed);
    const target = path.join(installed, binaryName(deps.platform));
    await fsp.rename(path.join(staging, artifact.entry), target);
    if (deps.platform !== "win32") await fsp.chmod(target, 0o755);
    // The hash already pins it; the signature check is what endpoint
    // security will judge, so refuse anything it would flag.
    if (
      deps.platform === "darwin" &&
      !(await deps.signedByTeam(target, VANA_APPLE_TEAM_ID))
    ) {
      throw new Error("The tunnel client is not signed by Vana.");
    }
    await fsp.writeFile(
      path.join(installed, ".installed"),
      `${artifact.sha256}\n`,
    );
    await fsp.rm(deps.managedDir, { recursive: true, force: true });
    await fsp.rename(installed, deps.managedDir);
    return path.join(deps.managedDir, binaryName(deps.platform));
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}
