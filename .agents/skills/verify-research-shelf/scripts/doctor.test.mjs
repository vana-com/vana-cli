import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("verify.mjs", import.meta.url));

test("doctor checks the same explicit Motel binary used by launch", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shelf-doctor-"));
  const run = (binary) =>
    spawnSync(process.execPath, [driver, "--doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        SHELF_VERIFY_CHROMIUM: process.execPath,
        // Stand-ins exercise file preflight only; no browser or collector starts.
        MOTEL_BINARY: process.execPath,
        SHELF_MOTEL_BINARY: binary,
      },
    });
  try {
    const unavailable = run(path.join(home, "missing-motel"));
    assert.equal(unavailable.status, 2);
    assert.equal(JSON.parse(unavailable.stdout).ready, false);

    const installed = run(process.execPath);
    assert.equal(installed.status, 0, installed.stderr);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.ready, true);
    assert.equal(result.motelBinary, process.execPath);
    assert.equal(result.launches, "none");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
