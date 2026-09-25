import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { VanaNetworkName } from "../../core/network.js";
import { localServerDataDir } from "./config.js";

/** Events after which the background server will not become ready. */
const FAILURES = new Set([
  "server-needs-login",
  "server-needs-owner-confirmation",
  "server-setup-required",
  "server-owner-confirmation-failed",
  "server-failed",
  "server-exited",
  "server-already-running",
]);

export interface DetachedStart {
  /** Every event the background server wrote, in order. */
  events: Array<Record<string, unknown>>;
  ready: boolean;
  pid: number | null;
  logPath: string;
}

function readEvents(logPath: string): Array<Record<string, unknown>> {
  let text = "";
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.type === "string") events.push(event);
    } catch {
      // A partial line; read it next time.
    }
  }
  return events;
}

/**
 * Run `vana server start` again as a background process that outlives this
 * one, and wait until it answers: ready, and once registered, until its
 * public URL answers too. It runs with --no-input, so everything that needs
 * a person (login, owner confirmation, installs) must be done before.
 */
export async function startDetachedServer(input: {
  network: VanaNetworkName;
  port?: number;
  local?: boolean;
  timeoutMs?: number;
  tunnelTimeoutMs?: number;
  /** Called once per event, as the background server writes it. */
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<DetachedStart> {
  const logDir = localServerDataDir(input.network);
  await fsp.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, "detached.log");
  await fsp.writeFile(logPath, "", { mode: 0o600 });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      process.argv[1],
      "server",
      "start",
      // The background process is the server itself; without this it would
      // detach again.
      "--foreground",
      "--json",
      "--no-input",
      "--yes",
      "--network",
      input.network,
      ...(input.port ? ["--port", String(input.port)] : []),
      ...(input.local ? ["--local"] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, VANA_DETACHED: "1" },
      windowsHide: true,
    },
  );
  fs.closeSync(logFd);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const started = Date.now();
  let readyAt: number | null = null;
  let reported = 0;
  for (;;) {
    const events = readEvents(logPath);
    for (const event of events.slice(reported)) input.onEvent?.(event);
    reported = events.length;
    const ready = events.find((event) => event.type === "server-ready");
    const failed = events.some((event) => FAILURES.has(String(event.type)));
    if (failed || (exited && !ready)) {
      return { events, ready: false, pid: child.pid ?? null, logPath };
    }
    if (ready) {
      readyAt ??= Date.now();
      const settled =
        ready.registered !== true ||
        events.some((event) => event.type === "server-tunnel") ||
        Date.now() - readyAt > (input.tunnelTimeoutMs ?? 90_000);
      if (settled) {
        return { events, ready: true, pid: child.pid ?? null, logPath };
      }
    }
    if (Date.now() - started > (input.timeoutMs ?? 5 * 60_000)) {
      return { events, ready: false, pid: child.pid ?? null, logPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
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

/** The pid of a `vana server start` running from this network's data dir. */
export function runningServerPid(network: VanaNetworkName): number | null {
  try {
    const pid = Number(
      JSON.parse(
        fs.readFileSync(
          path.join(localServerDataDir(network), ".vana-cli.lock"),
          "utf8",
        ),
      ).pid,
    );
    return pid > 0 && processIsRunning(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stop the server `vana server start` runs for this network, detached or
 * not, the way Ctrl+C does, and wait until it has cleaned up.
 */
export async function stopLocalServer(
  network: VanaNetworkName,
  timeoutMs = 20_000,
): Promise<"stopped" | "not-running" | "timeout"> {
  const pid = runningServerPid(network);
  if (!pid) return "not-running";
  process.kill(pid, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processIsRunning(pid)) return "stopped";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "timeout";
}
