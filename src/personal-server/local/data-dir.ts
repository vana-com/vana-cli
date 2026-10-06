import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getLogsDir } from "../../core/paths.js";
import type { VanaNetworkName } from "../../core/network.js";
import { accountServerDataDir, networkServerDir } from "./config.js";
import type { RunningServer } from "./server.js";

// One server per owner account: its key (registered on-chain to that owner),
// its index and its data. Up to 0.38 the CLI kept one server per network in
// ~/.vana/cli/personal-server/<network>/, whoever owned it; that dir now holds
// one dir per owner, and an old server's files move into its owner's dir the
// first time any account starts a server there.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const OWNER_FILE = ".vana-cli-owner.json";
const LOCK_FILE = ".vana-cli.lock";
const MOVING_PREFIX = ".moving-";

function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined,
) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of a `vana server start` running from `dir`, from its lock. */
export function serverPidIn(dir: string): number | null {
  const pid = Number(readJson(path.join(dir, LOCK_FILE))?.pid);
  return pid > 0 && processIsRunning(pid) ? pid : null;
}

/** The server's own key address in `dir`, when it has one. */
export function serverKeyAddress(dir: string): string | null {
  const address = readJson(path.join(dir, "key.json"))?.address;
  return typeof address === "string" && ADDRESS.test(address) ? address : null;
}

function recordedOwner(dir: string): string | null {
  const owner = readJson(path.join(dir, OWNER_FILE))?.owner;
  return typeof owner === "string" && ADDRESS.test(owner) ? owner : null;
}

async function recordOwner(
  dir: string,
  owner: string,
  network: VanaNetworkName,
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (recordedOwner(dir)) return;
  await fsp.writeFile(
    path.join(dir, OWNER_FILE),
    `${JSON.stringify({ owner, network }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** The owner the server's tunnel config names, when its key matches. */
function tunnelOwner(dir: string, key: string): string | null {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, "tunnel", "frpc.toml"), "utf8");
  } catch {
    return null;
  }
  const value = (name: string) =>
    new RegExp(`^metadatas\\.${name}\\s*=\\s*"(0x[0-9a-fA-F]{40})"`, "m").exec(
      text,
    )?.[1] ?? null;
  return sameAddress(value("wallet"), key) ? value("owner") : null;
}

/**
 * The owner the server named for this key when it last started: every start
 * logs "Server account loaded" with both addresses.
 */
function loggedOwner(key: string): string | null {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(getLogsDir())
      .filter((name) => name.startsWith("server-start-"))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(getLogsDir(), name), "utf8");
    } catch {
      continue;
    }
    if (!text.toLowerCase().includes(key.toLowerCase())) continue;
    for (const line of text.split("\n").reverse()) {
      if (!line.includes("Server account loaded")) continue;
      try {
        const entry = JSON.parse(line) as {
          owner?: unknown;
          serverAddress?: unknown;
        };
        if (
          typeof entry.owner === "string" &&
          ADDRESS.test(entry.owner) &&
          typeof entry.serverAddress === "string" &&
          sameAddress(entry.serverAddress, key)
        ) {
          return entry.owner;
        }
      } catch {
        // Not a log entry.
      }
    }
  }
  return null;
}

/**
 * Who owns the server an older vana kept straight in the network dir: a
 * running server answering with its key, its tunnel config, or its start
 * logs. Null when there is no such server, or nothing says whose it is.
 */
export function legacyServerOwner(
  network: VanaNetworkName,
  running: RunningServer[] = [],
): string | null {
  const dir = networkServerDir(network);
  const key = serverKeyAddress(dir);
  if (!key) return null;
  const live = running.find(
    (server) =>
      sameAddress(server.identity, key) &&
      typeof server.owner === "string" &&
      ADDRESS.test(server.owner),
  );
  return (
    recordedOwner(dir) ??
    live?.owner ??
    tunnelOwner(dir, key) ??
    loggedOwner(key)
  );
}

/**
 * Move an older vana's server out of the network dir into its owner's dir:
 * through a staging dir, so an interrupted move finishes next time.
 */
async function moveLegacyServer(
  network: VanaNetworkName,
  owner: string,
): Promise<void> {
  const legacy = networkServerDir(network);
  const target = accountServerDataDir(network, owner);
  const staging = path.join(legacy, `${MOVING_PREFIX}${owner.toLowerCase()}`);
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
  for (const name of await fsp.readdir(legacy)) {
    if (ADDRESS.test(name) || name.startsWith(MOVING_PREFIX)) continue;
    await fsp.rename(path.join(legacy, name), path.join(staging, name));
  }
  // The lock is stale: nothing runs from here (checked by the caller).
  await fsp.rm(path.join(staging, LOCK_FILE), { force: true });
  await recordOwner(staging, owner, network);
  await fsp.rename(staging, target);
}

/** Finish a move an earlier start began and did not complete. */
async function finishInterruptedMoves(network: VanaNetworkName): Promise<void> {
  const legacy = networkServerDir(network);
  let names: string[] = [];
  try {
    names = await fsp.readdir(legacy);
  } catch {
    return;
  }
  for (const name of names) {
    const owner = name.slice(MOVING_PREFIX.length);
    if (!name.startsWith(MOVING_PREFIX) || !ADDRESS.test(owner)) continue;
    if (fs.existsSync(accountServerDataDir(network, owner))) continue;
    await moveLegacyServer(network, owner);
  }
}

export type DataDirResolution =
  | {
      kind: "ready";
      dir: string;
      /** Set when this start moved the owner's server from an older layout. */
      movedFrom?: string;
    }
  | {
      /** An older vana's server whose owner nothing on this machine names. */
      kind: "unknown-owner";
      legacyDir: string;
      dir: string;
    };

/**
 * The data dir `owner`'s server runs from on `network`, created when it is
 * new. An older vana's server is moved into its owner's dir first, whoever
 * starts, unless it is running; another account's server is never handed out.
 */
export async function resolveServerDataDir(
  network: VanaNetworkName,
  owner: string,
  running: RunningServer[] = [],
): Promise<DataDirResolution> {
  const dir = accountServerDataDir(network, owner);
  const legacy = networkServerDir(network);
  if (!serverPidIn(legacy)) await finishInterruptedMoves(network);
  const recorded = recordedOwner(dir);
  if (recorded && !sameAddress(recorded, owner)) {
    throw new Error(`${dir} holds the Personal Server of ${recorded}.`);
  }
  if (fs.existsSync(dir) || !serverKeyAddress(legacy)) {
    await recordOwner(dir, owner, network);
    return { kind: "ready", dir };
  }

  const legacyOwner = legacyServerOwner(network, running);
  if (serverPidIn(legacy)) {
    // Never move a running server. If it is this owner's, it is theirs to use.
    if (sameAddress(legacyOwner, owner)) return { kind: "ready", dir: legacy };
    await recordOwner(dir, owner, network);
    return { kind: "ready", dir };
  }
  if (!legacyOwner) return { kind: "unknown-owner", legacyDir: legacy, dir };
  if (!fs.existsSync(accountServerDataDir(network, legacyOwner))) {
    await moveLegacyServer(network, legacyOwner);
  }
  await recordOwner(dir, owner, network);
  return sameAddress(legacyOwner, owner)
    ? { kind: "ready", dir, movedFrom: legacy }
    : { kind: "ready", dir };
}

/** A data dir `vana server start` runs or ran a server from. */
export interface CliServerDir {
  dir: string;
  owner: string | null;
  /** The server's own key address, when it has one. */
  identity: string | null;
  /** Its process, while it runs. */
  pid: number | null;
}

/** Every CLI server data dir on `network`, the older layout's included. */
export function listServerDataDirs(network: VanaNetworkName): CliServerDir[] {
  const legacy = networkServerDir(network);
  const found: CliServerDir[] = [];
  if (serverKeyAddress(legacy) || serverPidIn(legacy)) {
    found.push({
      dir: legacy,
      owner: legacyServerOwner(network),
      identity: serverKeyAddress(legacy),
      pid: serverPidIn(legacy),
    });
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(legacy);
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    if (!ADDRESS.test(name)) continue;
    const dir = path.join(legacy, name);
    found.push({
      dir,
      owner: recordedOwner(dir) ?? name,
      identity: serverKeyAddress(dir),
      pid: serverPidIn(dir),
    });
  }
  return found;
}

/** The CLI servers running on `network` right now. */
export function runningCliServers(network: VanaNetworkName): CliServerDir[] {
  return listServerDataDirs(network).filter((entry) => entry.pid);
}

/**
 * Which of the servers vana runs `vana server stop` stops: the signed-in
 * account's. Without an account, or for a server whose owner nothing names,
 * the only one running.
 */
export function serverToStop(
  servers: CliServerDir[],
  account: string | null,
): { target: CliServerDir | null; others: CliServerDir[] } {
  const target =
    servers.find((server) => sameAddress(server.owner, account)) ??
    (servers.length === 1 &&
    (!account || account === "env" || !servers[0].owner)
      ? servers[0]
      : null);
  return {
    target,
    others: servers.filter((server) => server !== target),
  };
}
