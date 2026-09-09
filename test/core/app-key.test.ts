import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppKeyMissingError,
  InvalidAppKeyError,
  readAppKeyPointer,
  resolveAppKey,
  type KeychainBackend,
} from "../../src/core/app-key.js";

const KEY_A =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function memoryKeychain(initial?: string): KeychainBackend & {
  stored: string | null;
} {
  const backend = {
    stored: initial ?? null,
    get() {
      return backend.stored;
    },
    set(value: string) {
      backend.stored = value;
      return true;
    },
  };
  return backend;
}

describe("resolveAppKey", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-app-key-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prefers VANA_APP_KEY and never stores it", () => {
    const keychain = memoryKeychain();
    const resolved = resolveAppKey({
      env: { VANA_APP_KEY: KEY_A },
      keychain,
    });
    expect(resolved.source).toBe("env");
    expect(resolved.privateKey).toBe(KEY_A);
    expect(resolved.publicKey.startsWith("0x04")).toBe(true);
    expect(keychain.stored).toBeNull();
    expect(fs.existsSync(path.join(home, ".vana", "app-key.json"))).toBe(false);
  });

  it("rejects a malformed env key", () => {
    expect(() =>
      resolveAppKey({ env: { VANA_APP_KEY: "0xnope" }, keychain: null }),
    ).toThrow(InvalidAppKeyError);
  });

  it("falls back to the keychain and writes the address pointer", () => {
    const resolved = resolveAppKey({
      env: {},
      keychain: memoryKeychain(KEY_A),
    });
    expect(resolved.source).toBe("keychain");
    const pointer = readAppKeyPointer();
    expect(pointer?.address).toBe(resolved.address);
    expect(pointer?.source).toBe("keychain");
  });

  it("throws when nothing exists and generation is not allowed", () => {
    expect(() => resolveAppKey({ env: {}, keychain: null })).toThrow(
      AppKeyMissingError,
    );
  });

  it("generates into the keychain when allowed", () => {
    const keychain = memoryKeychain();
    const resolved = resolveAppKey({
      env: {},
      keychain,
      allowGenerate: true,
    });
    expect(resolved.source).toBe("generated");
    expect(keychain.stored).toBe(resolved.privateKey);
    expect(fs.existsSync(path.join(home, ".vana", "app-key.json"))).toBe(false);
    // Second resolution finds the same key in the keychain.
    const again = resolveAppKey({ env: {}, keychain });
    expect(again.source).toBe("keychain");
    expect(again.address).toBe(resolved.address);
  });

  it("generates into the 0600 file when there is no keychain", () => {
    const resolved = resolveAppKey({
      env: {},
      keychain: null,
      allowGenerate: true,
    });
    const file = path.join(home, ".vana", "app-key.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = resolveAppKey({ env: {}, keychain: null });
    expect(again.source).toBe("file");
    expect(again.address).toBe(resolved.address);
  });
});
