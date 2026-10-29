import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CliExitCode } from "./exit-codes.js";
const PROBE_TIMEOUT_MS = 5_000;
const CLEANUP_GRACE_MS = 5_000;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PROGRESS_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 8 * 1024;
const checkName = z.enum([
  "format",
  "typecheck",
  "lint",
  "tests",
  "conformance",
  "startup-smoke",
  "connector-lint",
  "manifest-context",
]);
const progressSchema = z.discriminatedUnion("event", [
  z
    .object({
      version: z.literal(1),
      event: z.literal("check_started"),
      name: checkName,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      event: z.literal("check_finished"),
      name: checkName,
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      ms: z.number().finite().nonnegative(),
    })
    .strict(),
]);
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: CliExitCode = CliExitCode.FAILURE,
  ) {
    super(message);
  }
}
export const messages = {
  invalid_arguments:
    "Factory rejected the command arguments. See vana connectors build --instructions.",
  invalid_request:
    "Factory rejected the request. Review the request format with vana connectors build --instructions.",
  operation_locked:
    "This Factory job is locked by another operation. Wait for that operation to finish before resuming the explicit job.",
  operation_failed:
    "Factory could not complete the operation. Check the job's private work file and local Factory setup.",
  unsupported_runtime:
    "Factory requires a real Node 24+ runtime on macOS or Linux. See vana connectors build --instructions.",
  interrupted:
    "Factory was interrupted. Resume the explicit job after cleanup completes.",
};
export function protocolError(): AdapterError {
  return new AdapterError(
    "factory_protocol_error",
    "Factory returned an invalid, incompatible or inconsistent response. See vana connectors build --instructions.",
  );
}
export async function resolveExecutable(): Promise<string> {
  const override = process.env.VANA_FACTORY_BUILD;
  if (
    override !== undefined &&
    (!override ||
      !path.isAbsolute(override) ||
      /[\x00-\x1f\x7f]/.test(override))
  ) {
    throw new AdapterError(
      "factory_setup_required",
      "VANA_FACTORY_BUILD must name one absolute executable path. See vana connectors build --instructions.",
    );
  }
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, "factory-build"));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new AdapterError(
    "factory_setup_required",
    "Install the separately supplied factory-build executable under Node 24+ on macOS or Linux, then put it on PATH or set VANA_FACTORY_BUILD to its absolute path. See vana connectors build --instructions.",
  );
}

export async function invoke(
  executable: string,
  argv: string[],
  quiet: boolean,
  signal?: AbortSignal,
): Promise<{ value: unknown; exitCode: number | null; interrupted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    let resultBytes = 0;
    let progressBytes = 0;
    let pending = "";
    let failure: AdapterError | undefined;
    let interrupted = false;
    let closed = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The owned group may already have exited. */
      }
    };
    const requestCleanup = (signal: NodeJS.Signals) => {
      if (closed || cleanupTimer) return;
      child.kill(signal);
      cleanupTimer = setTimeout(() => {
        failure = new AdapterError(
          "factory_cleanup_incomplete",
          "Factory did not finish cleanup within 5 seconds. Its owned process group was terminated. Check for orphan checks and follow Factory manual lock recovery before resuming the explicit job.",
        );
        killGroup();
      }, CLEANUP_GRACE_MS);
    };
    const probeTimer =
      argv[0] === "capabilities"
        ? setTimeout(() => {
            failure = new AdapterError(
              "factory_probe_timeout",
              "Factory's capability probe did not respond within 5 seconds. Check the executable and its Node runtime. See vana connectors build --instructions.",
            );
            requestCleanup("SIGTERM");
          }, PROBE_TIMEOUT_MS)
        : undefined;
    const forward = (signal: NodeJS.Signals) => {
      interrupted = true;
      requestCleanup(signal);
    };
    const sigint = () => forward("SIGINT");
    const sigterm = () => forward("SIGTERM");
    const abort = () => forward("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    const fail = () => {
      if (!failure) {
        failure = protocolError();
        requestCleanup("SIGTERM");
      }
    };
    const progressLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      try {
        const parsed = progressSchema.safeParse(JSON.parse(line));
        if (parsed.success && !quiet) {
          process.stderr.write(`${JSON.stringify(parsed.data)}\n`);
        }
      } catch {
        /* Raw Factory stderr is deliberately discarded. */
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      resultBytes += chunk.length;
      if (resultBytes > MAX_RESULT_BYTES) fail();
      else stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      progressBytes += Buffer.byteLength(chunk);
      if (progressBytes > MAX_PROGRESS_BYTES) {
        fail();
        return;
      }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        progressLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) fail();
    });
    child.on("error", () => {
      failure = new AdapterError(
        "factory_setup_required",
        "The factory-build executable could not start. See vana connectors build --instructions.",
      );
    });
    child.once("exit", killGroup);
    child.on("close", (exitCode) => {
      closed = true;
      clearTimeout(probeTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      progressLine(pending);
      if (failure) {
        reject(failure);
        return;
      }
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        );
        resolve({ value, exitCode, interrupted });
      } catch {
        reject(
          interrupted
            ? new AdapterError("interrupted", messages.interrupted)
            : protocolError(),
        );
      }
    });
  });
}
