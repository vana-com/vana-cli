import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { VanaNetworkName } from "../../core/network.js";
import type { ResolvedNode } from "../../pdpp/host.js";
import {
  LOCAL_SERVER_PORTS,
  localServerDataDir,
  localServerNetwork,
} from "./config.js";
import type { OwnerBinding } from "./owner-binding.js";

/** A server already answering on a local port, and who owns it. */
export interface RunningServer {
  url: string;
  owner: string | null;
}

/** Every server answering on the ports Desktop and the CLI use. */
export async function findRunningServers(
  fetchImpl: typeof fetch = fetch,
): Promise<RunningServer[]> {
  const found: RunningServer[] = [];
  const seen = new Set<string>();
  for (let port = 8080; port <= 8085; port += 1) {
    const url = `http://localhost:${port}`;
    try {
      const response = await fetchImpl(`${url}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        owner?: unknown;
        identity?: { address?: unknown };
      };
      // A server also answers on its approval port (port + 1); its own key
      // says it is the same server.
      const identity =
        typeof body.identity?.address === "string"
          ? body.identity.address
          : null;
      if (identity && seen.has(identity.toLowerCase())) continue;
      if (identity) seen.add(identity.toLowerCase());
      found.push({
        url,
        owner: typeof body.owner === "string" ? body.owner : null,
      });
    } catch {
      // Nothing there.
    }
  }
  return found;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** A port whose neighbour is free too: the server's approval page takes port + 1. */
export async function choosePort(requested?: number): Promise<number | null> {
  const candidates = requested ? [requested] : [...LOCAL_SERVER_PORTS];
  for (const port of candidates) {
    if ((await portIsFree(port)) && (await portIsFree(port + 1))) {
      return port;
    }
  }
  return null;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim a data dir for this process. A lock whose pid is gone is stale and is
 * taken over; a live one means a server is already running from that dir.
 */
export async function acquireDataDirLock(
  dir: string,
): Promise<() => Promise<void>> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".vana-cli.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      await handle.close();
      return async () => {
        await fsp.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid = 0;
      try {
        pid = Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid);
      } catch {
        pid = 0;
      }
      if (pid > 0 && processIsRunning(pid)) {
        throw new Error(
          `A Personal Server started by vana is already running from ${dir} (pid ${pid}).`,
        );
      }
      await fsp.rm(lockPath, { force: true });
    }
  }
  throw new Error(`Could not lock ${dir}.`);
}

export interface LocalServerHandle {
  url: string;
  port: number;
  accessToken: string;
  /** Resolves when the server process exits, for whatever reason. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/**
 * Start the pinned Personal Server as a foreground child process on the
 * managed Node, local only, and wait until it answers.
 */
export async function startLocalServer(input: {
  network: VanaNetworkName;
  node: ResolvedNode;
  runtimeDir: string;
  binding: OwnerBinding;
  port: number;
  logPath: string;
  readyTimeoutMs?: number;
}): Promise<LocalServerHandle> {
  const dataDir = localServerDataDir(input.network);
  const release = await acquireDataDirLock(dataDir);
  const accessToken = crypto.randomBytes(32).toString("hex");
  const log = fs.createWriteStream(input.logPath, { flags: "a" });

  // Only what the server needs: no PDPP_*, no tokens from the caller's shell.
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: `${path.dirname(input.node.path)}${path.delimiter}${process.env.PATH ?? ""}`,
    NODE_ENV: "production",
    PS_ACCESS_TOKEN: accessToken,
    TUNNEL_ENABLED: "false",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
  const child: ChildProcess = spawn(input.node.path, ["entry.mjs"], {
    cwd: input.runtimeDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      void release();
      log.end();
      resolve(code);
    });
  });

  const ready = new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as {
            type?: string;
            url?: string;
            message?: string;
          };
          log.write(`[entry] ${line}\n`);
          if (message.type === "ready")
            resolve(message.url ?? `http://localhost:${input.port}`);
          if (message.type === "error")
            reject(
              new Error(
                message.message ?? "The Personal Server failed to start.",
              ),
            );
        } catch {
          log.write(`[entry] ${line}\n`);
        }
      }
    });
    child.once("error", (error) => reject(error));
    void exited.then((code) =>
      reject(
        new Error(
          `The Personal Server exited (code ${code}) before it was ready. See ${input.logPath}.`,
        ),
      ),
    );
  });

  const network = localServerNetwork(input.network);
  child.stdin?.write(
    `${JSON.stringify({
      rootPath: dataDir,
      port: input.port,
      ownerSignature: input.binding.signature,
      ownerAddress: input.binding.signerAddress,
      network: {
        gatewayUrl: network.gatewayUrl,
        chainId: network.chainId,
        contracts: network.contracts,
        storageApiUrl: network.storageApiUrl,
      },
    })}\n`,
  );
  child.stdin?.end();

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGINT");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killer);
  };

  let timer: NodeJS.Timeout | null = null;
  try {
    const url = await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `The Personal Server did not become ready in time. See ${input.logPath}.`,
              ),
            ),
          input.readyTimeoutMs ?? 120_000,
        );
      }),
    ]);
    return { url, port: input.port, accessToken, exited, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
