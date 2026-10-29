import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConnectorBuildCommands } from "../../src/cli/connector-build.js";

const id = "11111111-1111-4111-8111-111111111111";
const capabilities = {
  version: 1,
  kind: "factory_capabilities",
  packageVersion: "0.0.1",
  protocolVersion: 1,
  contextVersion: 2,
  apiPreparationVersion: 1,
  cancellation: true,
  nodeVersion: "v24.22.1",
  platform: "darwin",
  supported: true,
  supportedRoutes: ["export", "api"],
};
let directory: string;
let executable: string;
let configFile: string;
let callsFile: string;
let requestFile: string;
let checkout: string;
let stdout: string;
let stderr: string;
function job(state: Record<string, unknown> = {}) {
  return {
    version: 1,
    id,
    sourceId: "different-source-id",
    connectorDirectory: path.join(checkout, "connectors", "example_export"),
    manifestConnectorKey: "example-export",
    workFile: path.join(directory, "private", "work.md"),
    stateDirectory: path.join(directory, "state"),
    collectionContext: {
      checkout,
      directoryKey: "example_export",
      requestedStreams: ["items", "profile"],
      access: { kind: "export", inputEnvironmentName: "EXAMPLE_EXPORT_PATH" },
    },
    status: "agent_work",
    reason: "build",
    ...state,
  };
}
function pass() {
  const base: Record<string, unknown> = job();
  delete base.reason;
  return {
    ...base,
    status: "checks_passed",
    evidence: {
      runId: "22222222-2222-4222-8222-222222222222",
      fingerprint: "a".repeat(64),
      checkedAt: "2026-10-29T00:00:00Z",
      checks: [
        "format",
        "typecheck",
        "lint",
        "tests",
        "conformance",
        "startup-smoke",
        "connector-lint",
      ],
      scope: "static_and_fixture",
    },
    liveVerification: "pending",
    ingestion: "not_run",
  };
}
async function configure(changes: Record<string, unknown> = {}) {
  await writeFile(
    configFile,
    JSON.stringify({ capabilities, result: job(), exitCode: 0, ...changes }),
  );
}
async function run(
  args: string[],
  globals: { quiet?: boolean; detach?: boolean } = {},
) {
  stdout = "";
  stderr = "";
  const program = new Command().exitOverride();
  registerConnectorBuildCommands(program.command("connectors"), () => ({
    json: true,
    ...globals,
  }));
  await program.parseAsync([
    "node",
    "vana",
    "connectors",
    ...args,
    "--state-dir",
    path.join(directory, "state"),
  ]);
  const code = process.exitCode;
  process.exitCode = undefined;
  return {
    code,
    value: JSON.parse(stdout) as Record<string, any>,
    stdout,
    stderr,
  };
}
async function profile(manifest: Record<string, unknown> = {}) {
  const connector = path.join(checkout, "connectors", "example_export");
  await mkdir(connector, { recursive: true });
  await writeFile(path.join(connector, "index.ts"), "export {};\n");
  await writeFile(
    path.join(connector, "manifest.json"),
    JSON.stringify({
      connector_key: "example-export",
      version: "0.0.1",
      streams: [{ name: "items" }, { name: "profile" }],
      ...manifest,
    }),
  );
}

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "vana-factory-protocol-")),
  );
  executable = path.join(directory, "factory fixture");
  configFile = path.join(directory, "wire.json");
  callsFile = path.join(directory, "calls.jsonl");
  requestFile = path.join(directory, "request.json");
  checkout = path.join(directory, "checkout's space");
  await mkdir(checkout, { recursive: true });
  await mkdir(path.join(directory, "state"), { recursive: true });
  await writeFile(
    requestFile,
    JSON.stringify({
      version: 1,
      source: {
        id: "different-source-id",
        access: { kind: "export", inputEnv: "EXAMPLE_EXPORT_PATH" },
      },
      checkout,
      connectorDirectory: "example_export",
      manifestConnectorKey: "example-export",
      goal: { streams: [{ name: "items" }, { name: "profile" }] },
    }),
  );
  await writeFile(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'capabilities') {
  if (config.hangProbe) { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (config.mutateRequest) fs.writeFileSync(config.mutateRequest.path, JSON.stringify(config.mutateRequest.value));
  process.stdout.write(JSON.stringify(config.capabilities));
  process.exit(config.probeExit ?? 0);
}
if (config.ignoreTermination) {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(config.pidFile, String(process.pid));
  process.stdout.write('x'.repeat(256 * 1024 + 1));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (config.cancelOperation) {
  process.on('SIGTERM', () => {
    fs.writeFileSync(config.cleanupFile, 'cleaned');
    process.stdout.write(JSON.stringify({ ...config.result, reason: 'interrupted', interrupted: true }));
    process.exit(1);
  });
  process.stderr.write(JSON.stringify({ version: 1, event: 'check_started', name: 'tests' }) + '\\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (config.captureRequest && process.argv[2] === 'build') {
  const request = process.argv[process.argv.indexOf('--request') + 1];
  fs.writeFileSync(config.captureRequest, JSON.stringify({ path: request, value: JSON.parse(fs.readFileSync(request, 'utf8')) }));
}
if (config.stderr) process.stderr.write(config.stderr);
process.stdout.write(config.raw ?? JSON.stringify(config.result));
process.exit(config.exitCode);
`,
  );
  await chmod(executable, 0o700);
  await configure();
  vi.stubEnv("VANA_FACTORY_BUILD", executable);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("connector build subprocess policy", () => {
  it("prints bundled instructions without resolving Factory or reading a request", async () => {
    vi.stubEnv("VANA_FACTORY_BUILD", "invalid shell text");
    const output = await run(["build", "--instructions"]);
    expect(output.code).toBe(0);
    expect(output.value).toMatchObject({
      version: 1,
      kind: "connector_build_instructions",
    });
    expect(output.value.instructions).toContain("static_and_fixture");
    expect(output.value.instructions).toContain("VANA_FACTORY_BUILD");
    await expect(readFile(callsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds an unresponsive capability probe without starting a job", async () => {
    await configure({ hangProbe: true });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_probe_timeout");
    expect((await readFile(callsFile, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );
  }, 8_000);

  it("forwards cancellation and waits for the subprocess cleanup result", async () => {
    const cleanupFile = path.join(directory, "cleanup.txt");
    await configure({ cancelOperation: true, cleanupFile });
    vi.mocked(process.stderr.write).mockImplementation((chunk) => {
      const output = String(chunk);
      stderr += output;
      if (output.includes('"event":"check_started"')) process.emit("SIGTERM");
      return true;
    });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value).toMatchObject({
      id,
      status: "agent_work",
      reason: "interrupted",
      interrupted: true,
    });
    expect(await readFile(cleanupFile, "utf8")).toBe("cleaned");
  });

  it("reaps a hostile owned process group and reports incomplete graceful cleanup", async () => {
    const pidFile = path.join(directory, "pid.txt");
    await configure({ ignoreTermination: true, pidFile });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_cleanup_incomplete");
    expect(output.value.error.message).toContain("manual lock recovery");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 8_000);

  it("passes an immutable request snapshot and removes its temporary copy", async () => {
    const original = JSON.parse(await readFile(requestFile, "utf8"));
    const capture = path.join(directory, "captured-request.json");
    await configure({
      mutateRequest: {
        path: requestFile,
        value: { ...original, manifestConnectorKey: "incompatible" },
      },
      captureRequest: capture,
    });
    const output = await run(["build", "--request", requestFile]);
    expect(output.code).toBe(0);
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.value).toEqual(original);
    expect(
      JSON.parse(await readFile(requestFile, "utf8")).manifestConnectorKey,
    ).toBe("incompatible");
    await expect(readFile(captured.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves exact immutable context and separate same-job argv", async () => {
    const output = await run(["build", "--request", requestFile]);
    expect(output.code).toBe(0);
    expect(output.value).toMatchObject({
      id,
      sourceId: "different-source-id",
      collectionContext: job().collectionContext,
    });
    expect(output.value.actions).toEqual({
      check: {
        argv: [
          "vana",
          "connectors",
          "check",
          "--job",
          id,
          "--state-dir",
          job().stateDirectory,
          "--json",
        ],
      },
      resume: {
        argv: [
          "vana",
          "connectors",
          "resume",
          "--job",
          id,
          "--state-dir",
          job().stateDirectory,
          "--json",
        ],
      },
    });
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0]).toEqual(["capabilities", "--json"]);
    expect(calls[1]).toContain("vana");
    expect(calls).toHaveLength(2);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("offers collection only after pass and Vana local profile validation", async () => {
    await profile();
    await configure({ result: pass() });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(0);
    expect(output.value).toMatchObject({
      liveVerification: "pending",
      ingestion: "not_run",
      evidence: { scope: "static_and_fixture" },
    });
    expect(output.value.actions.connect).toEqual({
      argv: [
        "vana",
        "connect",
        "example_export",
        "--from",
        checkout,
        "--streams",
        "items,profile",
        "--factory-job",
        job().id,
        "--factory-state-dir",
        job().stateDirectory,
      ],
      requiredEnvironmentNames: ["EXAMPLE_EXPORT_PATH"],
    });
  });

  it("hands API plans to Factory and offers explicit same-job preparation", async () => {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    const access = {
      kind: "api",
      documentation: ["https://docs.example.test/items"],
      authEnvironmentNames: ["EXAMPLE_API_TOKEN"],
      preparation: {
        origin: "https://api.example.test",
        auth: {
          kind: "authorization",
          scheme: "Token",
          environmentName: "EXAMPLE_API_TOKEN",
        },
        research: [
          {
            name: "items-docs",
            url: "https://docs.example.test/items",
            input: {
              kind: "supplied",
              path: "/synthetic/api-docs.md",
              audience: "synthetic",
            },
          },
        ],
        samples: [
          {
            name: "items",
            streams: ["items"],
            input: { kind: "get", path: "/items" },
          },
        ],
        disclosure: { fields: ["$.items", "$.items[].id"], tokens: [] },
      },
    };
    await writeFile(
      requestFile,
      JSON.stringify({ ...request, source: { ...request.source, access } }),
    );
    const result = job({
      reason: "prepare",
      collectionContext: {
        ...job().collectionContext,
        access: { kind: "api", authEnvironmentNames: ["EXAMPLE_API_TOKEN"] },
      },
    });
    const capture = path.join(directory, "api-request.json");
    await configure({ result, captureRequest: capture });
    const built = await run(["build", "--request", requestFile]);
    expect(built.code).toBe(0);
    expect(built.value.reason).toBe("prepare");
    expect(built.value.actions.connect).toBeUndefined();
    expect(
      JSON.parse(await readFile(capture, "utf8")).value.source.access,
    ).toEqual(access);
    expect(built.value.actions.prepare.argv).toEqual([
      "vana",
      "connectors",
      "prepare",
      "--job",
      id,
      "--state-dir",
      result.stateDirectory,
      "--json",
    ]);
    const prepared = await run(built.value.actions.prepare.argv.slice(2, -3));
    expect(prepared.code).toBe(0);
    const calls = (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[3]).toEqual([
      "prepare",
      "--job",
      id,
      "--state-dir",
      result.stateDirectory,
      "--json",
    ]);
  });

  it.each([
    { authEnvironmentNames: [] },
    { authEnvironmentNames: ["EXAMPLE_API_TOKEN", "EXAMPLE_API_KEY"] },
  ])(
    "derives API collection environment names from checked context %j",
    async ({ authEnvironmentNames }) => {
      await profile();
      await configure({
        result: {
          ...pass(),
          collectionContext: {
            ...job().collectionContext,
            access: { kind: "api", authEnvironmentNames },
          },
        },
      });
      const output = await run(["check", "--job", id]);
      expect(output.code).toBe(0);
      expect(output.value.actions.connect.requiredEnvironmentNames).toEqual(
        authEnvironmentNames,
      );
      expect(output.value.actions.prepare.argv).toContain(id);
      expect(output.value).toMatchObject({
        evidence: { scope: "static_and_fixture" },
        liveVerification: "pending",
        ingestion: "not_run",
      });
    },
  );

  it.each([
    { version: undefined },
    { connector_key: "example_export" },
    { streams: [{ name: "items" }] },
  ])("refuses unusable local collection handoff %j", async (manifest) => {
    await profile(manifest);
    await configure({ result: pass() });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_local_profile_incompatible");
    expect(output.value.actions?.connect).toBeUndefined();
  });

  it("rejects incompatible keys before starting Factory", async () => {
    const request = JSON.parse(await readFile(requestFile, "utf8"));
    await writeFile(
      requestFile,
      JSON.stringify({ ...request, manifestConnectorKey: "another-source" }),
    );
    const output = await run(["build", "--request", requestFile]);
    expect(output.code).toBe(2);
    expect(output.value.error.code).toBe("invalid_request");
    await expect(readFile(callsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["prepare", "check", "resume"])(
    "requires an explicit job for %s",
    async (operation) => {
      const output = await run([operation]);
      expect(output.code).toBe(2);
      expect(output.value.error.code).toBe("invalid_arguments");
      await expect(readFile(callsFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects detach even for instructions", async () => {
    const output = await run(["build", "--instructions"], { detach: true });
    expect(output.code).toBe(2);
    expect(output.value.error.code).toBe("invalid_arguments");
  });

  it.each([
    {
      capabilities: {
        ...capabilities,
        contextVersion: 1,
        apiPreparationVersion: undefined,
        supportedRoutes: ["export"],
      },
      code: "factory_context_incompatible",
    },
    {
      capabilities: { ...capabilities, protocolVersion: 2 },
      code: "factory_protocol_error",
    },
    {
      capabilities: {
        ...capabilities,
        nodeVersion: "v22.23.4",
        supported: false,
      },
      code: "unsupported_runtime",
    },
    {
      capabilities: { ...capabilities, platform: "win32", supported: false },
      code: "unsupported_runtime",
    },
  ])(
    "rejects incompatible capability before job mutation %j",
    async ({ capabilities: probe, code }) => {
      await configure({ capabilities: probe });
      const output = await run(["build", "--request", requestFile]);
      expect(output.code).toBe(1);
      expect(output.value.error.code).toBe(code);
      expect(
        (await readFile(callsFile, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
    },
  );

  it("does not execute a shell fragment in the override", async () => {
    vi.stubEnv(
      "VANA_FACTORY_BUILD",
      `${executable}; touch ${directory}/injected`,
    );
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_setup_required");
    await expect(
      readFile(path.join(directory, "injected")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["invalid_arguments", 2, 2],
    ["invalid_request", 2, 2],
    ["operation_locked", 1, 1],
    ["operation_failed", 1, 1],
    ["unsupported_runtime", 1, 1],
  ])(
    "maps typed %s errors without relaying private messages",
    async (code, coreExit, expectedExit) => {
      await configure({
        result: {
          version: 1,
          error: { code, message: "PRIVATE EXPORT DATA AND TOKEN" },
        },
        exitCode: coreExit,
      });
      const output = await run(["check", "--job", id]);
      expect(output.code).toBe(expectedExit);
      expect(output.value.error.code).toBe(code);
      expect(output.stdout).not.toContain("PRIVATE");
    },
  );

  it.each([
    ["human_prerequisite", { requirements: ["PRIVATE INPUT"] }, 0, 7],
    ["blocked", { code: "inputs_unavailable", detail: "PRIVATE INPUT" }, 1, 1],
    [
      "checks_failed",
      {
        findings: [
          { name: "tests", exitCode: 1, logFile: "/private/checks.json" },
        ],
      },
      1,
      1,
    ],
    ["agent_work", { reason: "interrupted", interrupted: true }, 1, 1],
    ["agent_work", { reason: "interrupted" }, 0, 0],
  ])(
    "preserves %s outcome semantics",
    async (status, fields, coreExit, expectedExit) => {
      const base: Record<string, unknown> = job();
      delete base.reason;
      await configure({
        result: { ...base, status, ...fields },
        exitCode: coreExit,
      });
      const output = await run(["resume", "--job", id]);
      expect(output.code).toBe(expectedExit);
      expect(output.value.status).toBe(status);
      expect(output.value.actions.connect).toBeUndefined();
      expect(output.stdout).not.toContain("PRIVATE INPUT");
    },
  );

  it.each(["", "not JSON", "{}\n{}", '"' + "a".repeat(256 * 1024) + '"'])(
    "bounds and rejects malformed or multiple result frames",
    async (raw) => {
      await configure({ raw });
      const output = await run(["check", "--job", id]);
      expect(output.code).toBe(1);
      expect(output.value.error.code).toBe("factory_protocol_error");
    },
  );

  it.each([
    () => ({ result: job(), exitCode: 1 }),
    () => ({
      result: job({
        collectionContext: {
          ...job().collectionContext,
          exportInputEnvironmentName: "OLD_EXPORT_PATH",
        },
      }),
    }),
    () => ({
      result: job({
        collectionContext: {
          ...job().collectionContext,
          access: { kind: "api", authEnvironmentNames: ["bad name"] },
        },
      }),
    }),
    () => ({ result: job({ id: "33333333-3333-4333-8333-333333333333" }) }),
    () => ({
      result: job({
        collectionContext: {
          ...job().collectionContext,
          directoryKey: "elsewhere",
        },
      }),
    }),
    () => ({
      result: {
        version: 1,
        error: { code: "operation_locked", message: "locked" },
      },
      exitCode: 2,
    }),
  ])("rejects identity and exit contradictions", async (changes) => {
    await configure(changes());
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_protocol_error");
  });

  it("emits only safe progress on stderr, and quiet suppresses that progress", async () => {
    await configure({
      stderr:
        'PRIVATE CHECK LOG\n{"version":1,"event":"check_started","name":"tests","token":"PRIVATE"}\n{"version":1,"event":"check_started","name":"tests"}\n',
    });
    const normal = await run(["check", "--job", id]);
    expect(normal.stderr).toBe(
      '{"version":1,"event":"check_started","name":"tests"}\n',
    );
    const quiet = await run(["check", "--job", id], { quiet: true });
    expect(quiet.stderr).toBe("");
    expect(quiet.value).toEqual(normal.value);
  });

  it("bounds hostile stderr without relaying it", async () => {
    await configure({ stderr: "SECRET".repeat(30_000) });
    const output = await run(["check", "--job", id]);
    expect(output.code).toBe(1);
    expect(output.value.error.code).toBe("factory_protocol_error");
    expect(output.stderr).toBe("");
    expect(output.stdout).not.toContain("SECRET");
  });
});
