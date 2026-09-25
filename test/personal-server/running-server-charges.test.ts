import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runningServerCharges } from "../../src/cli/server-start.js";

const KEY = "0xd230d113f3bc83f416a824ad80f2923429a3d874";

describe("runningServerCharges", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-charges-"));
    process.env.HOME = home;
    dir = path.join(home, ".vana", "cli", "personal-server", "moksha");
    fs.mkdirSync(dir, { recursive: true });
    // A live pid holds the lock, as a running `vana server start` does.
    fs.writeFileSync(
      path.join(dir, ".vana-cli.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    fs.writeFileSync(
      path.join(dir, "key.json"),
      JSON.stringify({ address: KEY }),
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const writeConfig = (config: unknown) =>
    fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify(config));

  it("is false for the CLI's own server started without payment", () => {
    writeConfig({ devUi: { enabled: true } });
    expect(runningServerCharges("moksha", KEY.toUpperCase())).toBe(false);
  });

  it("is true once its config charges", () => {
    writeConfig({ payment: { enabled: true } });
    expect(runningServerCharges("moksha", KEY)).toBe(true);
  });

  it("says nothing about a server with another key, such as Desktop's", () => {
    writeConfig({});
    expect(runningServerCharges("moksha", "0x" + "1".repeat(40))).toBeNull();
    expect(runningServerCharges("moksha", null)).toBeNull();
  });

  it("says nothing when the config cannot be read", () => {
    fs.writeFileSync(path.join(dir, "server.json"), "{not json");
    expect(runningServerCharges("moksha", KEY)).toBeNull();
  });

  it("says nothing when no CLI server holds the lock", () => {
    writeConfig({});
    fs.rmSync(path.join(dir, ".vana-cli.lock"));
    expect(runningServerCharges("moksha", KEY)).toBeNull();
  });
});
