import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { findCompatibleNodeSync } from "../../src/pdpp/host.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("VANA_") &&
      !key.startsWith("PDPP_") &&
      key !== "NODE_OPTIONS",
  ),
);
let connectorNode: string;
let buildRoot: string | undefined;
let root: string | undefined;

beforeAll(async () => {
  const node = findCompatibleNodeSync(">=24.15.0 <25");
  if (!node) throw new Error("Set VANA_PDPP_NODE to an installed Node 24.");
  connectorNode = node.path;
  buildRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vana-pdpp-cancel-build-"),
  );
  await fs.writeFile(
    path.join(buildRoot, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await fs.symlink(
    path.join(repo, "node_modules"),
    path.join(buildRoot, "node_modules"),
  );
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--project",
      "tsconfig.json",
      "--outDir",
      path.join(buildRoot, "dist"),
      "--tsBuildInfoFile",
      path.join(buildRoot, "tsconfig.tsbuildinfo"),
    ],
    { cwd: repo, env: cleanEnv, stdio: "pipe" },
  );
  await fs.cp(
    path.join(repo, "src/vendor"),
    path.join(buildRoot, "dist/vendor"),
    {
      recursive: true,
    },
  );
}, 60_000);

afterAll(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true, force: true });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(process.platform === "win32")(
  "ordinary PDPP collection cancellation",
  () => {
    it.each(["SIGINT", "SIGTERM"] as const)(
      "%s preserves accepted data and releases the provider and collection lock",
      async (signal) => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "vana-pdpp-cancel-"));
        const home = path.join(root, "home");
        const checkout = path.join(root, "checkout");
        const connector = path.join(checkout, "connectors", "cancel");
        await fs.mkdir(connector, { recursive: true });
        await fs.writeFile(
          path.join(connector, "manifest.json"),
          JSON.stringify({
            connector_key: "cancel",
            version: "0.0.1",
            streams: [{ name: "items" }],
          }),
        );
        await fs.writeFile(
          path.join(connector, "index.ts"),
          `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.once("line", (line) => {
  const start = JSON.parse(line);
  if (start.type !== "START") throw new Error("Expected START");
  const generation = Number(process.env.CANCEL_GENERATION);
  emit({ type: "RECORD", stream: "items", key: "one", data: { generation } });
  emit({ type: "STATE", stream: "items", cursor: { generation } });
  if (process.env.CANCEL_WAIT === "1") {
    emit({ type: "PROGRESS", message: "ready:" + process.pid });
    setInterval(() => {}, 1000);
  } else {
    emit({ type: "DONE", status: "succeeded", records_emitted: 1 });
  }
});
`,
        );
        await fs.writeFile(
          path.join(checkout, "package.json"),
          JSON.stringify({ type: "module", engines: { node: ">=20" } }),
        );
        await fs.mkdir(path.join(checkout, "node_modules", "tsx"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(checkout, "node_modules", "tsx", "package.json"),
          JSON.stringify({ type: "module", exports: "./index.mjs" }),
        );
        await fs.writeFile(
          path.join(checkout, "node_modules", "tsx", "index.mjs"),
          "",
        );
        const host = path.join(root, "host.mjs");
        await fs.writeFile(
          host,
          `import { PdppRuntime } from ${JSON.stringify(pathToFileURL(path.join(buildRoot!, "dist/pdpp/runtime.js")).href)};
const runtime = new PdppRuntime({ from: ${JSON.stringify(checkout)}, owner: "cancel-owner" });
const fetched = await runtime.fetchConnector("cancel");
for await (const event of runtime.runConnector({ source: "cancel", connectorPath: fetched.connectorPath, noInput: true })) {
  console.log(JSON.stringify(event));
}
`,
        );

        let providerPid: number | undefined;
        const run = (generation: number, interrupt?: NodeJS.Signals) =>
          new Promise<{
            events: Array<Record<string, unknown>>;
            output: string;
          }>((resolve, reject) => {
            const child = spawn(process.execPath, [host], {
              cwd: repo,
              env: {
                ...cleanEnv,
                VANA_HOME: home,
                VANA_PDPP_NODE: connectorNode,
                CANCEL_GENERATION: String(generation),
                CANCEL_WAIT: interrupt ? "1" : "0",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stdout += chunk;
              const ready = /ready:(\d+)/.exec(stdout);
              if (interrupt && ready && !providerPid) {
                providerPid = Number(ready[1]);
                child.kill(interrupt);
              }
            });
            child.stderr.on("data", (chunk) => (stderr += chunk));
            const watchdog = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error(`Collection timed out\n${stdout}\n${stderr}`));
            }, 10_000);
            child.on("error", (error) => {
              clearTimeout(watchdog);
              reject(error);
            });
            child.on("close", () => {
              clearTimeout(watchdog);
              resolve({
                events: stdout
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line)),
                output: stdout + stderr,
              });
            });
          });

        try {
          const control = await run(1);
          const accepted = control.events.find(
            (event) => event.type === "collection-complete",
          );
          expect(accepted, control.output).toBeDefined();
          const resultPath = String(accepted?.resultPath);
          const resultBefore = await fs.readFile(resultPath, "utf8");
          const stateDir = path.join(home, "pdpp", "state", "cancel");
          const [stateName] = await fs.readdir(stateDir);
          const statePath = path.join(stateDir, stateName);
          const stateBefore = await fs.readFile(statePath, "utf8");
          expect(JSON.parse(stateBefore).checkpoints.items).toEqual({
            generation: 1,
          });

          const cancelled = await run(2, signal);
          expect(providerPid, cancelled.output).toBeDefined();
          expect(
            cancelled.events.some(
              (event) => event.type === "collection-complete",
            ),
          ).toBe(false);
          expect(await fs.readFile(resultPath, "utf8")).toBe(resultBefore);
          expect(await fs.readFile(statePath, "utf8")).toBe(stateBefore);
          expect(
            await fs.readdir(stateDir),
            "Cancellation must release the collection lock",
          ).toEqual([stateName]);
          expect(() => process.kill(providerPid!, 0)).toThrowError(
            expect.objectContaining({ code: "ESRCH" }),
          );
          expect(cancelled.events).toContainEqual(
            expect.objectContaining({
              type: "runtime-error",
              message: expect.stringMatching(/cancel/i),
            }),
          );

          const next = await run(3);
          expect(next.events, next.output).toContainEqual(
            expect.objectContaining({ type: "collection-complete" }),
          );
          expect(
            JSON.parse(await fs.readFile(statePath, "utf8")).checkpoints.items,
          ).toEqual({ generation: 3 });
          expect(
            JSON.parse(await fs.readFile(resultPath, "utf8"))["cancel.items"]
              .items,
          ).toEqual([{ generation: 3 }]);
        } finally {
          if (providerPid) {
            try {
              process.kill(-providerPid, "SIGKILL");
            } catch {
              // The runtime already reaped the provider.
            }
          }
        }
      },
    );
  },
);
