import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
let buildDir: string;
let driver: string;
beforeAll(() => {
  buildDir = fs.mkdtempSync(path.join(process.cwd(), ".paid-read-driver-"));
  driver = path.join(buildDir, "driver.mjs");
  buildSync({
    entryPoints: ["test/cli/paid-read-crash-driver.ts"],
    outfile: driver,
    platform: "node",
    format: "esm",
    bundle: true,
    packages: "external",
    logLevel: "silent",
  });
});
afterAll(() => fs.rmSync(buildDir, { recursive: true, force: true }));
it.each([
  "after-nonce",
  "before-receipt-rename",
  "after-receipt",
  "after-send",
  "after-settlement",
])("restarts an abruptly terminated process at %s", (stage) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paid-read-process-"));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    VANA_HOME: root,
  };
  try {
    const first = spawnSync(process.execPath, [driver, root, stage], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(first.status, first.stderr).toBe(86);
    const second = spawnSync(process.execPath, [driver, root, "resume"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(second.status, second.stderr).toBe(0);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "fixture-ledger.json"), "utf8"),
    );
    expect(ledger.settled).toHaveLength(1);
    expect(new Set(ledger.sent).size).toBe(1);
    expect(ledger.pending).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("blocks another process, then recovers the killed owner's exact payment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paid-read-process-"));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    VANA_HOME: root,
  };
  const child = spawn(process.execPath, [driver, root, "hold-read"], {
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += String(data);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", (message) =>
        message === "payment-pending"
          ? resolve()
          : reject(new Error("Unexpected fixture checkpoint")),
      );
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(`Fixture exited before checkpoint: ${errors}`)),
      );
    });
    const overlap = spawnSync(process.execPath, [driver, root, "resume"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(overlap.status, overlap.stderr).toBe(6);
    expect(JSON.parse(overlap.stdout).code).toBe("not_ready");
    child.kill("SIGKILL");
    await exited;
    const retry = spawnSync(process.execPath, [driver, root, "resume"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(retry.status, retry.stderr).toBe(0);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "fixture-ledger.json"), "utf8"),
    );
    expect(new Set(ledger.sent).size).toBe(1);
    expect(ledger.settled).toHaveLength(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
