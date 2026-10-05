import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tempRoot: "",
  config: {} as Record<string, unknown>,
  updateCliConfig: vi.fn(async (patch: Record<string, unknown>) => {
    state.config = { ...state.config, ...patch };
  }),
  readCliConfig: vi.fn(async () => ({ ...state.config })),
}));

vi.mock("../../src/core/index.js", () => ({
  getTelemetryOutboxDir: () => path.join(state.tempRoot, "telemetry", "outbox"),
  readCliConfig: state.readCliConfig,
  updateCliConfig: state.updateCliConfig,
}));

describe("cli telemetry", () => {
  let stderr = "";
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    state.tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "vana-connect-telemetry-"),
    );
    state.config = {};
    state.readCliConfig.mockClear();
    state.updateCliConfig.mockClear();
    stderr = "";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    delete process.env.VANA_TELEMETRY_DISABLED;
    delete process.env.VANA_TELEMETRY_DEBUG;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await fs.rm(state.tempRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("creates an install id and reports enabled-by-default status", async () => {
    const { getTelemetryStatus } = await import("../../src/cli/telemetry.js");

    const status = await getTelemetryStatus();

    expect(status.enabled).toBe(true);
    expect(status.mode).toBe("normal");
    expect(status.reason).toBe("default");
    expect(status.installId).toMatch(/^inst_/);
    expect(state.updateCliConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetryInstallId: status.installId }),
    );
  });

  it("writes canonical envelopes to stderr in debug mode", async () => {
    process.env.VANA_TELEMETRY_DEBUG = "1";
    const { createCliTelemetrySession } =
      await import("../../src/cli/telemetry.js");

    const session = await createCliTelemetrySession({
      command: "status",
      cliVersion: "0.11.6",
      channel: "stable",
      installMethod: "development",
      options: {
        json: true,
        noInput: true,
        quiet: true,
        detach: false,
        ipc: false,
      },
    });

    session.markCommandResult({ exitCode: 0, outcome: "ok" });
    await session.persist();

    expect(stderr).toContain('"batchId"');
    expect(stderr).toContain('"sentAt"');
    // Host started + host terminal = 2 events in the envelope.
    expect(stderr).toContain('"lifecycle":"host"');
    expect(stderr).toContain('"phase":"started"');
    expect(stderr).toContain('"phase":"terminal"');
    expect(stderr).toContain('"outcome":"success"');
    expect(stderr).toContain('"producer":"cli"');
    expect(stderr).toContain('"producerVersion":"0.11.6"');

    // Debug mode bypasses the outbox entirely.
    await expect(
      fs.readdir(path.join(state.tempRoot, "telemetry", "outbox")),
    ).rejects.toThrow();
  });

  it("classifies host failure errorClass from outcome-derived signals", async () => {
    const { createCliTelemetrySession } =
      await import("../../src/cli/telemetry.js");

    const session = await createCliTelemetrySession({
      command: "connect",
      source: "github",
      cliVersion: "0.11.6",
      channel: "stable",
      installMethod: "development",
      options: {
        json: false,
        noInput: false,
        quiet: false,
        detach: false,
        ipc: false,
      },
    });

    // Tell the session the underlying cause was an auth failure.
    session.trackCliEvent({
      type: "outcome",
      status: "auth_failed",
    } as never);
    // No errorClass on the command result — session should fall back to the
    // outcome-derived signal captured above.
    session.markCommandResult({ exitCode: 1 });
    await session.persist();

    const outboxDir = path.join(state.tempRoot, "telemetry", "outbox");
    const [filename] = await fs.readdir(outboxDir);
    const envelope = JSON.parse(
      await fs.readFile(path.join(outboxDir, filename), "utf8"),
    ) as {
      batchId: string;
      sentAt: string;
      events: Array<{
        correlation: { scope: string };
        kind: {
          lifecycle: string;
          phase: string;
          outcome?: string;
          errorClass?: string;
        };
      }>;
    };

    expect(envelope.batchId).toMatch(/^batch_/);
    expect(envelope.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const hostTerminal = envelope.events.find(
      (e) =>
        e.correlation.scope === "host" &&
        e.kind.lifecycle === "host" &&
        e.kind.phase === "terminal",
    );
    expect(hostTerminal).toBeDefined();
    expect(hostTerminal!.kind.outcome).toBe("failure");
    // Preferred the outcome-derived 'auth_failed' signal over the raw 'unknown'.
    expect(hostTerminal!.kind.errorClass).toBe("auth_failed");
  });

  it("reports one honest collection terminal per source run", async () => {
    process.env.VANA_TELEMETRY_DEBUG = "1";
    const { createCliTelemetrySession } =
      await import("../../src/cli/telemetry.js");

    const session = await createCliTelemetrySession({
      command: "collect",
      cliVersion: "0.11.6",
      channel: "stable",
      installMethod: "development",
      options: {
        json: true,
        noInput: true,
        quiet: false,
        detach: false,
        ipc: false,
      },
    });

    // steam: asks for input nobody can give, then the connector gives up.
    session.trackCliEvent({
      type: "connector-resolved",
      source: "steam",
      connectorVersion: "1.0.1",
    });
    session.trackCliEvent({ type: "needs-input", source: "steam" });
    session.trackCliEvent({
      type: "runtime-error",
      source: "steam",
      message: "Input is disabled for this run.",
    });

    // shop: throws something no pattern names.
    session.trackCliEvent({
      type: "runtime-error",
      source: "shop",
      message: "Browser is closed.",
    });

    // github: writes a result file the CLI then rejects as an error.
    session.trackCliEvent({ type: "collection-complete", source: "github" });
    session.trackCliEvent({
      type: "outcome",
      status: "runtime_error",
      source: "github",
      reason: "Could not reach GitHub after multiple attempts.",
    });

    session.markCommandResult({ exitCode: 1 });
    await session.persist();

    const envelope = JSON.parse(stderr) as {
      events: Array<{
        context: { connectorVersion?: string };
        correlation: { source?: string; collectionRunId?: string };
        kind: Record<string, string>;
      }>;
    };
    const terminals = envelope.events.filter(
      (e) => e.kind.lifecycle === "collection" && e.kind.phase === "terminal",
    );

    expect(
      terminals.map((e) => [
        e.correlation.source,
        e.kind.outcome,
        e.kind.reason ?? e.kind.errorClass,
      ]),
    ).toEqual([
      ["steam", "cancelled", "abandoned"],
      ["shop", "failure", "runtime_error"],
      ["github", "failure", "network_error"],
    ]);
    expect(terminals[0].context.connectorVersion).toBe("1.0.1");
    expect(
      new Set(terminals.map((e) => e.correlation.collectionRunId)).size,
    ).toBe(3);
  });

  it("flushes queued batches to the canonical telemetry endpoint", async () => {
    const { createCliTelemetrySession, flushTelemetryOutbox } =
      await import("../../src/cli/telemetry.js");
    const fetchMock = vi.fn().mockResolvedValue({ status: 202 });
    vi.stubGlobal("fetch", fetchMock);

    const session = await createCliTelemetrySession({
      command: "connect",
      source: "github",
      cliVersion: "0.11.6",
      channel: "stable",
      installMethod: "development",
      options: {
        json: false,
        noInput: false,
        quiet: false,
        detach: false,
        ipc: false,
      },
    });

    session.markCommandResult({ exitCode: 0, outcome: "connected_local_only" });
    await session.persist();

    const outboxDir = path.join(state.tempRoot, "telemetry", "outbox");
    expect((await fs.readdir(outboxDir)).length).toBe(1);

    await flushTelemetryOutbox();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://telemetry.opendatalabs.com/v1/telemetry/events",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await fs.readdir(outboxDir)).toEqual([]);
  });
});
