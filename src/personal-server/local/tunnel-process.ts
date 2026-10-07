import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The server starts frpc as its own child with `-c <dataDir>/tunnel/frpc.toml`
// and stops it on a clean shutdown. A server that dies hard (kill -9, OOM)
// leaves that frpc behind, reparented to init, still holding the relay
// subdomain; nothing else would ever stop it. Whoever owns the data dir (the
// supervisor, `vana server stop`) owns that frpc's lifetime too.

/** One process as `ps` lists it. */
export interface ProcessEntry {
  pid: number;
  command: string;
}

export interface TunnelProcessDeps {
  listProcesses: () => Promise<ProcessEntry[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isRunning: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

async function listProcesses(): Promise<ProcessEntry[]> {
  // No ps on Windows; a stale frpc there is left to the person.
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axww", "-o", "pid=,command="],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) entries.push({ pid: Number(match[1]), command: match[2] });
    }
    return entries;
  } catch {
    return [];
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultTunnelProcessDeps(): TunnelProcessDeps {
  return {
    listProcesses,
    kill: (pid, signal) => process.kill(pid, signal),
    isRunning,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The frpc config the server writes for its tunnel in `dataDir`. */
export function tunnelConfigPath(dataDir: string): string {
  return path.join(dataDir, "tunnel", "frpc.toml");
}

/**
 * True when `command` runs an frpc on exactly `configPath`: another data
 * dir's tunnel (another account, Vana Desktop) never matches.
 */
export function isTunnelClientFor(
  command: string,
  configPath: string,
): boolean {
  const marker = ` -c ${configPath}`;
  const at = command.indexOf(marker);
  if (at <= 0) return false;
  const rest = command.slice(at + marker.length);
  if (rest && !/^\s/.test(rest)) return false;
  const executable = path.basename(command.slice(0, at).trim());
  return /^frpc(\.exe)?$/i.test(executable);
}

/** Pids of every frpc running on `dataDir`'s tunnel config. */
export async function findTunnelClients(
  dataDir: string,
  deps: TunnelProcessDeps = defaultTunnelProcessDeps(),
): Promise<number[]> {
  const configs = new Set([
    tunnelConfigPath(dataDir),
    tunnelConfigPath(path.resolve(dataDir)),
  ]);
  return (await deps.listProcesses())
    .filter(
      (entry) =>
        entry.pid !== process.pid &&
        [...configs].some((config) => isTunnelClientFor(entry.command, config)),
    )
    .map((entry) => entry.pid);
}

/**
 * Stop every frpc running on `dataDir`'s tunnel config: SIGTERM, then
 * SIGKILL what is left after `timeoutMs`. Returns the pids it stopped. Only
 * call it while no server runs from `dataDir`, or after it exited.
 */
export async function stopTunnelClients(
  dataDir: string,
  deps: TunnelProcessDeps = defaultTunnelProcessDeps(),
  timeoutMs = 5_000,
): Promise<number[]> {
  const pids = await findTunnelClients(dataDir, deps);
  const signal = (pid: number, name: NodeJS.Signals) => {
    try {
      deps.kill(pid, name);
    } catch {
      // Gone already.
    }
  };
  for (const pid of pids) signal(pid, "SIGTERM");
  const started = Date.now();
  while (
    pids.some((pid) => deps.isRunning(pid)) &&
    Date.now() - started < timeoutMs
  ) {
    await deps.sleep(100);
  }
  for (const pid of pids) {
    if (deps.isRunning(pid)) signal(pid, "SIGKILL");
  }
  return pids;
}
