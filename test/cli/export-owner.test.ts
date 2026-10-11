import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findCompatibleNodeSync } from "../../src/pdpp/host.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("VANA_") &&
      !key.startsWith("PDPP_") &&
      key !== "NODE_OPTIONS",
  ),
);
let connectorNode: string;

beforeAll(() => {
  const node = findCompatibleNodeSync(">=24.15.0 <25");
  if (!node) throw new Error("Set VANA_PDPP_NODE to an installed Node 24.");
  connectorNode = node.path;
  execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--build"],
    {
      cwd: repo,
      env: cleanEnv,
      stdio: "pipe",
    },
  );
  execFileSync(process.execPath, ["scripts/copy-vendor.mjs"], {
    cwd: repo,
    env: cleanEnv,
    stdio: "pipe",
  });
}, 60_000);

interface Upload {
  owner: string | null;
  authorization: string | undefined;
  body: unknown;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("account-bound queued exports at the CLI boundary", () => {
  let root: string;
  let home: string;
  let checkout: string;
  let executionFile: string;
  let server: http.Server;
  let url: string;
  let owner: string | null;
  let rejectUploads: boolean;
  let uploads: Upload[];
  let stateAtUpload: any;
  let rejectScope: string | undefined;
  let uploadGate: (() => Promise<void>) | undefined;

  async function write(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  async function login(address: string, expired = false) {
    owner = address;
    await write(path.join(home, "auth.json"), {
      account: {
        address,
        session_token: `fake-account-${address}`,
        expires_at: expired ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
      },
      personal_server: {
        url,
        session_token: `fake-ps-${address}`,
        expires_at: "2099-01-01T00:00:00Z",
      },
    });
  }

  function run(
    args: string[],
    extra: NodeJS.ProcessEnv = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli/bin.js", ...args], {
        cwd: repo,
        env: {
          ...cleanEnv,
          HOME: root,
          USERPROFILE: root,
          VANA_HOME: home,
          VANA_DATA_CONNECTORS_DIR: checkout,
          VANA_PERSONAL_SERVER_URL: url,
          VANA_TELEMETRY_DISABLED: "1",
          VANA_PDPP_NODE: connectorNode,
          FAKE_EXECUTION_FILE: executionFile,
          FAKE_RECORD_OWNER: owner ?? "unknown",
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI timed out: ${stdout}\n${stderr}`));
      }, 30_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function state() {
    return JSON.parse(
      await fs.readFile(path.join(home, "vana-connect-state.json"), "utf8"),
    );
  }

  async function collectA() {
    await login(A);
    rejectUploads = true;
    await run(["connect", "fake", "--from", checkout, "--no-input", "--json"]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      owner: A,
      authorization: `Bearer fake-ps-${A}`,
    });
    expect(stateAtUpload.sources.fake).toMatchObject({
      dataState: "collected_local",
      exportReceipt: {
        version: 1,
        owner: { accountUrl: "https://account.vana.org", address: A },
      },
    });
    const before = await state();
    expect(before.sources.fake.dataState).toBe("ingest_failed");
    const resultPath = before.sources.fake.lastResultPath as string;
    const bytes = await fs.readFile(resultPath);
    expect(bytes.toString()).toContain(A);
    const executions = await fs.readFile(executionFile, "utf8");
    rejectUploads = false;
    uploads = [];
    return {
      resultPath,
      bytes,
      executions,
      receipt: before.sources.fake.exportReceipt,
    };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vana-export-owner-"));
    home = path.join(root, "vana");
    checkout = path.join(root, "connector");
    executionFile = path.join(root, "executions.log");
    uploads = [];
    rejectUploads = false;
    rejectScope = undefined;
    uploadGate = undefined;
    stateAtUpload = undefined;
    server = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end(
          JSON.stringify({ status: "healthy", owner, version: "fake" }),
        );
      } else if (
        request.method === "POST" &&
        request.url?.startsWith("/v1/data/")
      ) {
        let body = "";
        for await (const chunk of request) body += chunk;
        uploads.push({
          owner,
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        });
        stateAtUpload = await state();
        const rejected = rejectUploads || request.url === rejectScope;
        await uploadGate?.();
        response.writeHead(rejected ? 503 : 201);
        response.end(rejected ? '{"error":"interrupted upload"}' : "{}");
      } else {
        response.writeHead(404);
        response.end("{}");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fake server port");
    url = `http://127.0.0.1:${address.port}`;
    await write(
      path.join(checkout, "connectors/fake/index.ts"),
      `
import fs from "node:fs";
import readline from "node:readline";
fs.appendFileSync(process.env.FAKE_EXECUTION_FILE, "run\\n");
const input = readline.createInterface({ input: process.stdin });
await input[Symbol.asyncIterator]().next();
if (process.env.FAKE_WAIT_FILE) {
  while (!fs.existsSync(process.env.FAKE_WAIT_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "RECORD", stream: "profile", key: "fake", data: { owner: process.env.FAKE_RECORD_OWNER, value: process.env.FAKE_RECORD_VALUE }, emitted_at: "2026-01-01T00:00:00Z" });
if (process.env.FAKE_SECOND_STREAM) emit({ type: "RECORD", stream: "other", key: "other", data: { owner: process.env.FAKE_RECORD_OWNER }, emitted_at: "2026-01-01T00:00:00Z" });
emit({ type: "DONE", status: "succeeded", records_emitted: process.env.FAKE_SECOND_STREAM ? 2 : 1 });
await new Promise((resolve) => input.once("close", resolve));
`,
    );
    await write(path.join(checkout, "connectors/fake/manifest.json"), {
      connector_key: "fake",
      display_name: "Fake",
      version: "0.0.1",
      streams: [{ name: "profile" }],
      export_frequency: "daily",
    });
    await write(path.join(checkout, "package.json"), { type: "module" });
    await write(path.join(checkout, "node_modules/tsx/package.json"), {
      type: "module",
      exports: "./index.mjs",
    });
    await write(path.join(checkout, "node_modules/tsx/index.mjs"), "");
    await write(path.join(checkout, "registry.json"), { connectors: [] });
    await write(path.join(checkout, "skills/vana-connect/scripts/.keep"), "");
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("blocks syncing A's interrupted export after account and server switch to B", async () => {
    const queued = await collectA();
    await login(B);
    const synced = await run(["server", "sync", "--no-input", "--json"]);
    expect.soft(synced.code, synced.stdout + synced.stderr).toBe(5);
    expect.soft(uploads).toEqual([]);
    expect.soft(await fs.readFile(queued.resultPath)).toEqual(queued.bytes);
    expect.soft((await state()).sources.fake.dataState).toBe("ingest_failed");
    expect
      .soft((await state()).sources.fake.exportReceipt)
      .toEqual(queued.receipt);
    expect
      .soft(JSON.parse(synced.stdout).error)
      .toBe("pending_exports_blocked");
  });

  it.each([
    ["connect", ["connect", "fake", "--no-input", "--json"]],
    ["IPC connect", ["connect", "fake", "--ipc", "--json"]],
    ["due collect", ["collect", "--all", "--no-input", "--json"]],
  ])(
    "blocks B's %s before replacing A's queued bytes or starting the connector",
    async (_name, args) => {
      const queued = await collectA();
      const before = await state();
      before.config = { localConnectors: { fake: { path: checkout } } };
      before.sources.fake.exportFrequency = "daily";
      before.sources.fake.lastCollectedAt = "2000-01-01T00:00:00Z";
      await write(path.join(home, "vana-connect-state.json"), before);
      await login(B);
      const collected = await run(args);
      expect.soft(collected.code, collected.stdout + collected.stderr).toBe(5);
      expect.soft(uploads).toEqual([]);
      expect.soft(await fs.readFile(queued.resultPath)).toEqual(queued.bytes);
      expect
        .soft(await fs.readFile(executionFile, "utf8"))
        .toBe(queued.executions);
      expect
        .soft((await state()).sources.fake.lastResultPath)
        .toBe(queued.resultPath);
    },
  );

  it("recovers A's original export with its live server token after Account login expires without recollection", async () => {
    const queued = await collectA();
    await login(B);
    await login(A, true);
    const synced = await run(["server", "sync", "--no-input", "--json"]);
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      owner: A,
      authorization: `Bearer fake-ps-${A}`,
    });
    expect(JSON.stringify(uploads[0].body)).toContain(A);
    expect(await fs.readFile(queued.resultPath)).toEqual(queued.bytes);
    expect(await fs.readFile(executionFile, "utf8")).toBe(queued.executions);
    expect((await state()).sources.fake.dataState).toBe(
      "ingested_personal_server",
    );
  });

  it.each(["missing receipt", "malformed receipt"])(
    "keeps a legacy export local and inspectable with %s",
    async (kind) => {
      const queued = await collectA();
      const saved = await state();
      saved.sources.fake.exportReceipt =
        kind === "missing receipt" ? undefined : { owner: A };
      await write(path.join(home, "vana-connect-state.json"), saved);
      const synced = await run(["server", "sync", "--no-input", "--json"]);
      expect(synced.code).toBe(5);
      // copy-assertion-ok: re-login must not be offered as a repair for missing provenance.
      expect(synced.stdout).toContain("receipt");
      expect(synced.stdout).not.toContain("Sign in");
      const inspected = await run(["data", "show", "fake", "--json"]);
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout).path).toBe(queued.resultPath);
      expect(inspected.stdout).toContain(A);
      const collected = await run([
        "connect",
        "fake",
        "--from",
        checkout,
        "--no-input",
        "--json",
      ]);
      expect(collected.code).toBe(5);
      expect(uploads).toEqual([]);
      expect(await fs.readFile(queued.resultPath)).toEqual(queued.bytes);
      expect(await fs.readFile(executionFile, "utf8")).toBe(queued.executions);
    },
  );

  it.each([
    "environment token",
    "missing health owner",
    "changed bytes",
    "different deployment",
  ])("refuses deferred upload with %s", async (kind) => {
    const queued = await collectA();
    let extra: NodeJS.ProcessEnv = {};
    if (kind === "environment token")
      extra = { VANA_SESSION_TOKEN: "fake-env-token" };
    if (kind === "missing health owner") owner = null;
    if (kind === "changed bytes") await fs.appendFile(queued.resultPath, " ");
    if (kind === "different deployment") {
      await fs.copyFile(
        path.join(home, "auth.json"),
        path.join(home, "auth.account-dev.vana.org.json"),
      );
      extra = { VANA_ENV: "dev" };
    }
    const beforeBytes = await fs.readFile(queued.resultPath);
    const synced = await run(["server", "sync", "--no-input", "--json"], extra);
    expect(synced.code, synced.stdout + synced.stderr).toBe(5);
    expect(uploads).toEqual([]);
    expect(await fs.readFile(queued.resultPath)).toEqual(beforeBytes);
    expect((await state()).sources.fake.exportReceipt).toEqual(queued.receipt);
  });

  it("preserves fresh accountless upload to an explicit destination without assigning its owner to later retry", async () => {
    owner = A;
    const extra = { VANA_PS_TOKEN: "fake-explicit-ps-token" };
    const collected = await run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      extra,
    );
    expect(collected.code, collected.stdout + collected.stderr).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].authorization).toBe("Bearer fake-explicit-ps-token");
    expect((await state()).sources.fake.exportReceipt.owner).toBeNull();
    rejectUploads = true;
    uploads = [];
    await run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      extra,
    );
    expect(uploads).toHaveLength(1);
    expect((await state()).sources.fake.dataState).toBe("ingest_failed");
    await login(A);
    rejectUploads = false;
    uploads = [];
    const synced = await run(["server", "sync", "--no-input", "--json"]);
    expect(synced.code).toBe(5);
    expect(JSON.parse(synced.stdout).error).toBe("pending_exports_blocked");
    expect(uploads).toEqual([]);
  });

  it("reports B's automatic and scheduled exclusion of a partially synced A export", async () => {
    await login(A);
    await write(path.join(checkout, "connectors/fake/manifest.json"), {
      connector_key: "fake",
      display_name: "Fake",
      version: "0.0.1",
      streams: [{ name: "profile" }, { name: "other" }],
    });
    rejectScope = "/v1/data/fake.other";
    const partial = await run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      {
        FAKE_SECOND_STREAM: "1",
      },
    );
    expect(partial.code, partial.stdout + partial.stderr).toBe(0);
    const saved = await state();
    expect(saved.sources.fake.dataState).toBe("ingested_personal_server");
    expect(saved.sources.fake.ingestScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "fake.profile", status: "stored" }),
        expect.objectContaining({ scope: "fake.other", status: "failed" }),
      ]),
    );
    saved.sources.fake.exportFrequency = "daily";
    await write(path.join(home, "vana-connect-state.json"), saved);
    const bytes = await fs.readFile(saved.sources.fake.lastResultPath);
    await login(B);
    uploads = [];
    for (const scheduled of [false, true]) {
      const collected = await run(
        ["collect", "--all", "--no-input", "--json"],
        scheduled ? { VANA_SCHEDULED_RUN: "1" } : {},
      );
      expect(collected.code).toBe(5);
      expect(JSON.parse(collected.stdout).sources).toEqual([
        expect.objectContaining({
          source: "fake",
          outcome: "sync_pending",
          error: expect.stringContaining(A),
        }),
      ]);
    }
    expect((await state()).lastScheduledRun).toMatchObject({
      exitCode: 5,
      sources: [{ source: "fake", outcome: "sync_pending" }],
    });
    expect(uploads).toEqual([]);
    expect(await fs.readFile(saved.sources.fake.lastResultPath)).toEqual(bytes);
  });

  it("preserves A's admitted bytes when B's already-running collection loses publication", async () => {
    await login(B);
    const gate = path.join(root, "release-b");
    const competing = run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      { FAKE_WAIT_FILE: gate },
    );
    while (
      !(await fs.readFile(executionFile, "utf8").catch(() => "")).includes(
        "run",
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = await collectA();
    await login(B);
    await write(gate, "release");
    const rejected = await competing;
    expect(rejected.code, rejected.stdout + rejected.stderr).toBe(5);
    const outcome = rejected.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.reason === "pending_export_changed");
    expect(outcome.resultPath).not.toBe(queued.resultPath);
    expect(await fs.readFile(outcome.resultPath, "utf8")).toContain(B);
    expect(await fs.readFile(queued.resultPath)).toEqual(queued.bytes);
    expect((await state()).sources.fake.exportReceipt).toEqual(queued.receipt);
    expect(uploads).toEqual([]);
  });

  it("settles only the accepted generation when an earlier upload finishes after a newer collection", async () => {
    await login(A);
    rejectUploads = true;
    let release!: () => void;
    let posted!: () => void;
    const firstPosted = new Promise<void>((resolve) => {
      posted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    uploadGate = async () => {
      uploadGate = undefined;
      posted();
      await held;
    };
    const first = run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      { FAKE_RECORD_VALUE: "first" },
    );
    await firstPosted;
    const firstReceipt = (await state()).sources.fake.exportReceipt;
    rejectUploads = false;
    const second = await run(
      ["connect", "fake", "--from", checkout, "--no-input", "--json"],
      { FAKE_RECORD_VALUE: "second" },
    );
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const accepted = (await state()).sources.fake;
    release();
    expect((await first).code).toBe(5);
    expect(accepted.exportReceipt.id).not.toBe(firstReceipt.id);
    expect(await fs.readFile(firstReceipt.path, "utf8")).toContain("first");
    expect(await fs.readFile(accepted.lastResultPath, "utf8")).toContain(
      "second",
    );
    expect((await state()).sources.fake).toEqual(accepted);
  });
});
