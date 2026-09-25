import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getVanaHome, migrateLegacyDataHome } from "../../src/core/paths.js";

describe("getVanaHome", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is ~/.vana by default", () => {
    vi.stubEnv("VANA_HOME", "");
    expect(getVanaHome()).toBe(path.join(os.homedir(), ".vana"));
  });

  it("follows VANA_HOME, and leaves ~/.dataconnect alone then", () => {
    vi.stubEnv("VANA_HOME", "/tmp/vana-demo-home");
    expect(getVanaHome()).toBe(path.resolve("/tmp/vana-demo-home"));
    expect(migrateLegacyDataHome()).toBeNull();
  });
});
