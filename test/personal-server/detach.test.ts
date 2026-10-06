import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDetachedServer } from "../../src/personal-server/local/detach.js";

// The background server is `process.argv[1] server start ...`: point argv[1]
// at a script standing in for it, so nothing real is started.
let dir: string;
const originalArgv1 = process.argv[1];

function backgroundScript(body: string): void {
  const script = path.join(dir, "fake-vana.mjs");
  fs.writeFileSync(script, body);
  process.argv[1] = script;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-detach-"));
});
afterEach(() => {
  process.argv[1] = originalArgv1;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("startDetachedServer", () => {
  it("writes its output into the owner's data dir and passes on the failure", async () => {
    backgroundScript(
      `console.log(JSON.stringify({ type: "server-failed", message: "already running", logPath: "/x.log" }));\n`,
    );
    const seen: Array<Record<string, unknown>> = [];
    const dataDir = path.join(dir, "mainnet", "0xabc");
    const start = await startDetachedServer({
      network: "mainnet",
      dataDir,
      onEvent: (event) => void seen.push(event),
    });
    expect(start.ready).toBe(false);
    expect(start.logPath).toBe(path.join(dataDir, "detached.log"));
    expect(seen).toEqual([
      { type: "server-failed", message: "already running", logPath: "/x.log" },
    ]);
  });

  it("tells why when the background process dies without a word", async () => {
    backgroundScript(`throw new TypeError("boom");\n`);
    const seen: Array<Record<string, unknown>> = [];
    const start = await startDetachedServer({
      network: "mainnet",
      dataDir: dir,
      onEvent: (event) => void seen.push(event),
    });
    expect(start.ready).toBe(false);
    const failed = {
      type: "server-failed",
      message: "The background server exited: TypeError: boom",
      logPath: path.join(dir, "detached.log"),
    };
    expect(seen).toEqual([failed]);
    expect(start.events.at(-1)).toEqual(failed);
    expect(fs.existsSync(failed.logPath)).toBe(true);
  });
});
