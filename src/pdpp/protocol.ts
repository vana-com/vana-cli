import { spawn } from "node:child_process";

/**
 * Host side of the Collection Profile protocol: one JSON object per line on
 * stdin and stdout. The connector reads START, then emits records, cursors,
 * progress and interaction requests, and ends with exactly one DONE.
 */

export interface StartMessage {
  type: "START";
  run_id: string;
  collection_mode: "full_refresh" | "incremental";
  scope: { streams: Array<{ name: string }> };
  state: Record<string, unknown>;
}

export interface ConnectorRecord {
  stream: string;
  key: string;
  data: Record<string, unknown>;
  op?: "upsert" | "delete";
}

export interface SkipResult {
  stream?: string;
  reason?: string;
  message?: string;
}

export interface InteractionRequest {
  requestId: string;
  kind: string;
  message: string;
  schema?: { properties?: Record<string, unknown>; required?: string[] };
  timeoutMs: number;
}

export type InteractionReply =
  | { status: "success"; data?: Record<string, string> }
  | { status: "cancelled"; message: string };

export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  recordsEmitted: number;
  error?: { message: string; code?: string; retryable: boolean };
}

export interface RunProtocolOptions {
  node: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  start: StartMessage;
  signal?: AbortSignal;
  /** Silence after which a run is considered stuck; paused during interactions. */
  idleTimeoutMs?: number;
  onRecord(record: ConnectorRecord): void;
  onState(stream: string, cursor: Record<string, unknown>): void;
  onProgress(progress: {
    stream?: string;
    message: string;
    count?: number;
    total?: number;
  }): void;
  onSkip(skip: SkipResult): void;
  onInteraction(request: InteractionRequest): Promise<InteractionReply>;
  log(line: string): void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

// Protocol lines a host may see but has no use for; logged, not acted on.
const INFORMATIONAL_TYPES = new Set([
  "ASSISTANCE",
  "ASSISTANCE_STATUS",
  "STREAM_EVIDENCE",
  "DETAIL_GAP",
  "DETAIL_GAP_ATTEMPTED",
  "DETAIL_GAP_RECOVERED",
  "DETAIL_COVERAGE",
]);

const SENSITIVE_STDERR =
  /authorization|bearer|token|secret|password|cookie|session|csrf/i;

/** The last few stderr lines for an error message, or nothing if they may carry a secret. */
export function stderrExcerpt(lines: string[]): string {
  const tail = lines.slice(-8).join("\n").slice(-2048);
  if (!tail) return "";
  return SENSITIVE_STDERR.test(tail)
    ? "[stderr withheld: it may contain a credential]"
    : tail;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ProtocolError extends Error {}

export function runCollectionProfile(
  options: RunProtocolOptions,
): Promise<RunOutcome> {
  const streams = new Set(options.start.scope.streams.map((s) => s.name));
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  return new Promise<RunOutcome>((resolve) => {
    const child = spawn(options.node, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so stopping the run also stops the browser
      // the connector launched.
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let observedRecords = 0;
    let done: RunOutcome | null = null;
    let failure: RunOutcome | null = null;
    let interactionPending = false;
    let finished = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const stderrLines: string[] = [];

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // Already gone.
        }
      };
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };

    const fail = (message: string, status: RunOutcome["status"] = "failed") => {
      if (failure) return;
      failure = {
        status,
        recordsEmitted: observedRecords,
        error: { message, retryable: status !== "failed" },
      };
      options.log(`[host] ${message}`);
      stop();
    };

    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdle = () => {
      clearIdle();
      if (interactionPending || done) return;
      idleTimer = setTimeout(() => {
        fail(
          `The connector sent nothing for ${Math.round(idleTimeoutMs / 60_000)} minutes, so the run was stopped.`,
        );
      }, idleTimeoutMs);
    };

    const write = (message: unknown) => {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    };

    const onAbort = () => fail("Cancelled.", "cancelled");
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const answerInteraction = async (request: InteractionRequest) => {
      interactionPending = true;
      clearIdle();
      let timeout: NodeJS.Timeout | null = null;
      const timedOut = new Promise<InteractionReply>((settle) => {
        timeout = setTimeout(
          () =>
            settle({
              status: "cancelled",
              message: "Nobody answered in time.",
            }),
          request.timeoutMs,
        );
      });
      let reply: InteractionReply;
      try {
        reply = await Promise.race([options.onInteraction(request), timedOut]);
      } catch (error) {
        reply = {
          status: "cancelled",
          message: error instanceof Error ? error.message : "Cancelled.",
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      interactionPending = false;
      if (finished || failure) return;
      write(
        reply.status === "success"
          ? {
              type: "INTERACTION_RESPONSE",
              request_id: request.requestId,
              status: "success",
              ...(reply.data ? { data: reply.data } : {}),
            }
          : {
              type: "INTERACTION_RESPONSE",
              request_id: request.requestId,
              status: "cancelled",
              error: { message: reply.message },
            },
      );
      armIdle();
    };

    const handle = (message: Record<string, unknown>) => {
      const type = message.type;
      if (done) {
        throw new ProtocolError(
          `The connector sent ${String(type)} after DONE.`,
        );
      }
      switch (type) {
        case "RECORD": {
          const { stream, key, data, op } = message;
          if (typeof stream !== "string" || !streams.has(stream)) {
            throw new ProtocolError(
              `RECORD for a stream that was not requested: ${String(stream)}`,
            );
          }
          const recordKey = Array.isArray(key) ? JSON.stringify(key) : key;
          if (
            typeof recordKey !== "string" ||
            recordKey === "" ||
            !isObject(data)
          ) {
            throw new ProtocolError(
              `RECORD in ${stream} has no key or no data object.`,
            );
          }
          observedRecords += 1;
          options.onRecord({
            stream,
            key: recordKey,
            data,
            op: op === "delete" ? "delete" : "upsert",
          });
          return;
        }
        case "STATE": {
          const { stream, cursor } = message;
          if (
            typeof stream !== "string" ||
            !streams.has(stream) ||
            !isObject(cursor)
          ) {
            throw new ProtocolError(
              `STATE without a requested stream and cursor object.`,
            );
          }
          options.onState(stream, cursor);
          return;
        }
        case "PROGRESS":
          options.onProgress({
            stream:
              typeof message.stream === "string" ? message.stream : undefined,
            message: typeof message.message === "string" ? message.message : "",
            count:
              typeof message.count === "number" ? message.count : undefined,
            total:
              typeof message.total === "number" ? message.total : undefined,
          });
          return;
        case "SKIP_RESULT":
          options.onSkip({
            stream:
              typeof message.stream === "string" ? message.stream : undefined,
            reason:
              typeof message.reason === "string" ? message.reason : undefined,
            message:
              typeof message.message === "string" ? message.message : undefined,
          });
          return;
        case "INTERACTION": {
          if (interactionPending) {
            throw new ProtocolError(
              "A second INTERACTION arrived before the first was answered.",
            );
          }
          const {
            request_id,
            kind,
            message: text,
            schema,
            timeout_seconds,
          } = message;
          if (
            typeof request_id !== "string" ||
            typeof kind !== "string" ||
            typeof text !== "string"
          ) {
            throw new ProtocolError(
              "INTERACTION without request_id, kind and message.",
            );
          }
          void answerInteraction({
            requestId: request_id,
            kind,
            message: text,
            schema: isObject(schema)
              ? (schema as InteractionRequest["schema"])
              : undefined,
            timeoutMs:
              typeof timeout_seconds === "number" && timeout_seconds > 0
                ? timeout_seconds * 1000
                : DEFAULT_INTERACTION_TIMEOUT_MS,
          });
          return;
        }
        case "DETAIL_GAPS_PAGE_REQUEST":
          // This host keeps no detail-gap ledger, so every page is empty.
          write({
            type: "DETAIL_GAPS_PAGE_RESPONSE",
            request_id: message.request_id,
            reference_only: true,
            detail_gaps: [],
          });
          return;
        case "DONE": {
          const error = isObject(message.error) ? message.error : null;
          const recordsEmitted =
            typeof message.records_emitted === "number"
              ? message.records_emitted
              : -1;
          done = {
            status: message.status === "succeeded" ? "succeeded" : "failed",
            recordsEmitted,
            ...(error
              ? {
                  error: {
                    message:
                      typeof error.message === "string"
                        ? error.message
                        : "The connector failed.",
                    code:
                      typeof error.code === "string" ? error.code : undefined,
                    retryable: error.retryable === true,
                  },
                }
              : {}),
          };
          clearIdle();
          // The connector waits for stdin to close before it exits.
          child.stdin.end();
          return;
        }
        default:
          if (!INFORMATIONAL_TYPES.has(String(type))) {
            options.log(`[host] ignored unknown message type ${String(type)}`);
          }
      }
    };

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (
        Buffer.byteLength(buffer) > MAX_LINE_BYTES &&
        !buffer.includes("\n")
      ) {
        fail("The connector sent a line larger than 16 MiB.");
        buffer = "";
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line || failure) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail("The connector wrote something that is not a protocol message.");
          continue;
        }
        if (!isObject(parsed)) {
          fail("The connector wrote something that is not a protocol message.");
          continue;
        }
        try {
          handle(parsed);
          armIdle();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        options.log(`[connector] ${line}`);
        stderrLines.push(line);
        if (stderrLines.length > 50) stderrLines.shift();
      }
    });

    // The write side closes early when the connector exits; that is normal.
    child.stdin.on("error", () => {});

    child.on("error", (error) => {
      fail(`Could not start the connector: ${error.message}`);
    });

    child.on("close", (code, signal) => {
      finished = true;
      clearIdle();
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);

      if (failure) {
        resolve(failure);
        return;
      }
      const excerpt = stderrExcerpt(stderrLines);
      const withExcerpt = (message: string) =>
        excerpt ? `${message}\n${excerpt}` : message;

      if (!done) {
        resolve({
          status: "failed",
          recordsEmitted: observedRecords,
          error: {
            message: withExcerpt(
              `The connector exited (${signal ?? `code ${code}`}) without finishing.`,
            ),
            retryable: true,
          },
        });
        return;
      }
      const finalDone: RunOutcome = done;
      if (finalDone.status === "succeeded") {
        if (code !== 0) {
          resolve({
            status: "failed",
            recordsEmitted: observedRecords,
            error: {
              message: withExcerpt(
                `The connector reported success but exited with code ${code}.`,
              ),
              retryable: true,
            },
          });
          return;
        }
        if (finalDone.recordsEmitted !== observedRecords) {
          resolve({
            status: "failed",
            recordsEmitted: observedRecords,
            error: {
              message: `The connector reported ${finalDone.recordsEmitted} records but sent ${observedRecords}.`,
              retryable: true,
            },
          });
          return;
        }
      }
      resolve({ ...finalDone, recordsEmitted: observedRecords });
    });

    options.log(
      `[host] START ${JSON.stringify({ ...options.start, state: Object.keys(options.start.state) })}`,
    );
    write(options.start);
    armIdle();
  });
}
