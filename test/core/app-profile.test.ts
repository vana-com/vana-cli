import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAppProfile, saveAppProfile } from "../../src/core/app-profile.js";

describe("app profile", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-profile-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("remembers a name and URL per app address", () => {
    saveAppProfile("0xAAA", { name: "OpenClaw", url: "https://openclaw.ai" });
    saveAppProfile("0xbbb", { name: "Hermes" });
    expect(readAppProfile("0xaaa")).toEqual({
      name: "OpenClaw",
      url: "https://openclaw.ai",
    });
    expect(readAppProfile("0xBBB")).toEqual({ name: "Hermes" });
    expect(readAppProfile("0xccc")).toEqual({});
  });

  it("keeps the other field when only one is updated, and ignores empty input", () => {
    saveAppProfile("0xaaa", { name: "OpenClaw", url: "https://openclaw.ai" });
    saveAppProfile("0xaaa", { name: "OpenClaw agent" });
    saveAppProfile("0xaaa", { name: "  ", url: undefined });
    expect(readAppProfile("0xaaa")).toEqual({
      name: "OpenClaw agent",
      url: "https://openclaw.ai",
    });
  });
});
