import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runCollectionProfile,
  stderrExcerpt,
  type ConnectorRecord,
  type InteractionRequest,
  type InteractionReply,
  type RunProtocolOptions,
  type SkipResult,
} from "../../src/pdpp/protocol.js";

// A fake connector speaks the real wire protocol. Like the published runtime
// it exits only after the host closes stdin, so a host that forgets to close
// stdin after DONE hangs these tests.
const PRELUDE = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const waitForStdinClose = () => new Promise((resolve) => rl.once("close", resolve));
`;

const roots: string[] = [];
function connector(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-pdpp-proto-"));
  roots.push(dir);
  const file = path.join(dir, "connector.mjs");
  fs.writeFileSync(file, `${PRELUDE}\n${body}`);
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function run(
  file: string,
  overrides: Partial<RunProtocolOptions> = {},
): {
  promise: ReturnType<typeof runCollectionProfile>;
  records: ConnectorRecord[];
  states: Record<string, unknown>;
  skips: SkipResult[];
  interactions: InteractionRequest[];
  log: string[];
} {
  const records: ConnectorRecord[] = [];
  const states: Record<string, unknown> = {};
  const skips: SkipResult[] = [];
  const interactions: InteractionRequest[] = [];
  const log: string[] = [];
  const promise = runCollectionProfile({
    node: process.execPath,
    args: [file],
    cwd: path.dirname(file),
    env: { PATH: process.env.PATH },
    start: {
      type: "START",
      run_id: "test-run",
      collection_mode: "incremental",
      scope: { streams: [{ name: "sleeps" }, { name: "cycles" }] },
      state: { sleeps: { through: "2026-09-01" } },
    },
    onRecord: (record) => records.push(record),
    onState: (stream, cursor) => {
      states[stream] = cursor;
    },
    onProgress: () => {},
    onSkip: (skip) => skips.push(skip),
    onInteraction: async (request): Promise<InteractionReply> => {
      interactions.push(request);
      return { status: "success" };
    },
    log: (line) => log.push(line),
    ...overrides,
  });
  return { promise, records, states, skips, interactions, log };
}

describe("runCollectionProfile", () => {
  it("delivers START, collects records and cursors, and succeeds on DONE", async () => {
    const file = connector(`
      const start = await next();
      emit({ type: "RECORD", stream: "sleeps", key: "s1", data: { id: "s1", echo: start.state.sleeps.through }, emitted_at: "t" });
      emit({ type: "RECORD", stream: "cycles", key: ["c", 1], data: { id: 1 }, emitted_at: "t" });
      emit({ type: "STATE", stream: "sleeps", cursor: { through: "2026-09-23" } });
      emit({ type: "SKIP_RESULT", stream: "cycles", reason: "rate_limited", message: "Later." });
      emit({ type: "DONE", status: "succeeded", records_emitted: 2 });
      await waitForStdinClose();
    `);
    const { promise, records, states, skips } = run(file);
    const outcome = await promise;

    expect(outcome).toEqual({ status: "succeeded", recordsEmitted: 2 });
    expect(records[0]).toEqual({
      stream: "sleeps",
      key: "s1",
      data: { id: "s1", echo: "2026-09-01" },
      op: "upsert",
    });
    expect(records[1].key).toBe(JSON.stringify(["c", 1]));
    expect(states.sleeps).toEqual({ through: "2026-09-23" });
    expect(skips).toEqual([
      { stream: "cycles", reason: "rate_limited", message: "Later." },
    ]);
  });

  it("answers an interaction and lets the connector continue", async () => {
    const file = connector(`
      await next();
      emit({ type: "INTERACTION", request_id: "int_1", kind: "otp", message: "Code?", schema: { properties: { code: { type: "string" } } }, timeout_seconds: 60 });
      const reply = await next();
      emit({ type: "RECORD", stream: "sleeps", key: "r", data: { id: "r", reply }, emitted_at: "t" });
      emit({ type: "DONE", status: "succeeded", records_emitted: 1 });
      await waitForStdinClose();
    `);
    const { promise, records, interactions } = run(file, {
      onInteraction: async (request) => {
        interactions.push(request);
        return { status: "success", data: { code: "123456" } };
      },
    });
    expect((await promise).status).toBe("succeeded");
    expect(interactions[0]).toMatchObject({
      requestId: "int_1",
      kind: "otp",
      timeoutMs: 60_000,
    });
    expect(records[0].data.reply).toEqual({
      type: "INTERACTION_RESPONSE",
      request_id: "int_1",
      status: "success",
      data: { code: "123456" },
    });
  });

  it("cancels an interaction nobody answers in time", async () => {
    const file = connector(`
      await next();
      emit({ type: "INTERACTION", request_id: "int_2", kind: "manual_action", message: "Sign in", timeout_seconds: 0.2 });
      const reply = await next();
      process.exitCode = 1;
      emit({ type: "DONE", status: "failed", records_emitted: 0, error: { message: "reply was " + reply.status, retryable: false } });
      await waitForStdinClose();
    `);
    const { promise } = run(file, {
      onInteraction: () => new Promise<InteractionReply>(() => {}),
    });
    const outcome = await promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("reply was cancelled");
  });

  it("fails when DONE claims a different number of records than were sent", async () => {
    const file = connector(`
      await next();
      emit({ type: "RECORD", stream: "sleeps", key: "a", data: { id: "a" }, emitted_at: "t" });
      emit({ type: "DONE", status: "succeeded", records_emitted: 5 });
      await waitForStdinClose();
    `);
    const outcome = await run(file).promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/reported 5 records but sent 1/);
  });

  it("fails a connector that exits without DONE and includes its stderr", async () => {
    const file = connector(`
      await next();
      console.error("[browser-launch] could not start chrome");
      process.exit(3);
    `);
    const outcome = await run(file).promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/without finishing/);
    expect(outcome.error?.message).toMatch(/could not start chrome/);
  });

  it("passes a failed DONE through with its message", async () => {
    const file = connector(`
      await next();
      process.exitCode = 1;
      emit({ type: "DONE", status: "failed", records_emitted: 0, error: { code: "whoop_owner_repair_required", message: "Sign in again.", retryable: false } });
      await waitForStdinClose();
    `);
    const outcome = await run(file).promise;
    expect(outcome).toEqual({
      status: "failed",
      recordsEmitted: 0,
      error: {
        code: "whoop_owner_repair_required",
        message: "Sign in again.",
        retryable: false,
      },
    });
  });

  it("rejects a record for a stream that was not requested", async () => {
    const file = connector(`
      await next();
      emit({ type: "RECORD", stream: "workouts", key: "w", data: { id: "w" }, emitted_at: "t" });
      await new Promise(() => {});
    `);
    const outcome = await run(file).promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/not requested: workouts/);
  });

  it("stops a connector that goes silent", async () => {
    const file = connector(`
      await next();
      await new Promise(() => {});
    `);
    const outcome = await run(file, { idleTimeoutMs: 300 }).promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/sent nothing/);
  });

  it("does not count time waiting on the person as idle", async () => {
    const file = connector(`
      await next();
      emit({ type: "INTERACTION", request_id: "int_3", kind: "manual_action", message: "Sign in" });
      await next();
      emit({ type: "DONE", status: "succeeded", records_emitted: 0 });
      await waitForStdinClose();
    `);
    const outcome = await run(file, {
      idleTimeoutMs: 200,
      onInteraction: () =>
        new Promise<InteractionReply>((resolve) =>
          setTimeout(() => resolve({ status: "success" }), 600),
        ),
    }).promise;
    expect(outcome.status).toBe("succeeded");
  });

  it("cancels on abort", async () => {
    const file = connector(`
      await next();
      await new Promise(() => {});
    `);
    const controller = new AbortController();
    const { promise } = run(file, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const outcome = await promise;
    expect(outcome.status).toBe("cancelled");
  });

  it("answers a detail-gap page request with an empty page", async () => {
    const file = connector(`
      await next();
      emit({ type: "DETAIL_GAPS_PAGE_REQUEST", request_id: "page_1", reference_only: true });
      const page = await next();
      emit({ type: "RECORD", stream: "sleeps", key: "p", data: { id: "p", page }, emitted_at: "t" });
      emit({ type: "DONE", status: "succeeded", records_emitted: 1 });
      await waitForStdinClose();
    `);
    const { promise, records } = run(file);
    expect((await promise).status).toBe("succeeded");
    expect(records[0].data.page).toEqual({
      type: "DETAIL_GAPS_PAGE_RESPONSE",
      request_id: "page_1",
      reference_only: true,
      detail_gaps: [],
    });
  });

  it("fails on output that is not a protocol message", async () => {
    const file = connector(`
      await next();
      process.stdout.write("hello from a stray console.log\\n");
      await new Promise(() => {});
    `);
    const outcome = await run(file).promise;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/not a protocol message/);
  });
});

describe("stderrExcerpt", () => {
  it("keeps the last lines", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    expect(stderrExcerpt(lines)).toBe(lines.slice(-8).join("\n"));
  });

  it("withholds stderr that may carry a credential", () => {
    expect(stderrExcerpt(["Authorization: Bearer abc"])).toMatch(/withheld/);
  });
});
