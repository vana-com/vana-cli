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
  owner: string;
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
  let owner: string;
  let rejectUploads: boolean;
  let uploads: Upload[];

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

  function run(args: string[]): Promise<CommandResult> {
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
          FAKE_RECORD_OWNER: owner,
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
    const before = await state();
    expect(before.sources.fake.dataState).toBe("ingest_failed");
    const resultPath = before.sources.fake.lastResultPath as string;
    const bytes = await fs.readFile(resultPath);
    expect(bytes.toString()).toContain(A);
    const executions = await fs.readFile(executionFile, "utf8");
    rejectUploads = false;
    uploads = [];
    return { resultPath, bytes, executions };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vana-export-owner-"));
    home = path.join(root, "vana");
    checkout = path.join(root, "connector");
    executionFile = path.join(root, "executions.log");
    uploads = [];
    rejectUploads = false;
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
        response.writeHead(rejectUploads ? 503 : 201);
        response.end(rejectUploads ? '{"error":"interrupted upload"}' : "{}");
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
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "RECORD", stream: "profile", key: "fake", data: { owner: process.env.FAKE_RECORD_OWNER }, emitted_at: "2026-01-01T00:00:00Z" });
emit({ type: "DONE", status: "succeeded", records_emitted: 1 });
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
      .soft(synced.stdout + synced.stderr)
      .toMatch(/(owner|account|unattributed|attributed|belong)/i);
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
});
