/**
 * Builder ("app") key resolution.
 *
 * Precedence: `VANA_APP_KEY` env (taken as given, never stored) ->
 * OS keychain (macOS `security`, service `org.vana.cli`) -> plaintext file
 * fallback `~/.vana/app-key.json` at 0600 (the one documented exception to
 * "the keychain holds anything that signs"; `doctor` flags it) -> generated
 * on first use when the caller allows it.
 *
 * The derived address is mirrored to the nonsecret `~/.vana/app-key.address`
 * so `whoami` and `doctor` can name the identity without touching the
 * secret store.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { getVanaHome } from "./paths.js";

export type AppKeySource = "env" | "keychain" | "file" | "generated";

export interface ResolvedAppKey {
  privateKey: Hex;
  address: Address;
  /** Uncompressed secp256k1 public key (0x04 + 128 hex). */
  publicKey: Hex;
  source: AppKeySource;
}

const ENV_VAR = "VANA_APP_KEY";
const KEYCHAIN_SERVICE = "org.vana.cli";
const KEYCHAIN_ACCOUNT = "app-key";
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export class InvalidAppKeyError extends Error {
  constructor(where: string) {
    super(`${where} does not hold a 32-byte 0x-prefixed hex private key`);
    this.name = "InvalidAppKeyError";
  }
}

export class AppKeyMissingError extends Error {
  constructor() {
    super(
      "No app key found. Run a command that may create one, or set VANA_APP_KEY.",
    );
    this.name = "AppKeyMissingError";
  }
}

function keyFilePath(): string {
  return path.join(getVanaHome(), "app-key.json");
}

function addressFilePath(): string {
  return path.join(getVanaHome(), "app-key.address");
}

function toResolved(privateKey: Hex, source: AppKeySource): ResolvedAppKey {
  const account = privateKeyToAccount(privateKey);
  return {
    privateKey,
    address: account.address,
    publicKey: account.publicKey,
    source,
  };
}

/** Injectable keychain backend so tests never touch the real keychain. */
export interface KeychainBackend {
  get(): string | null;
  set(value: string): boolean;
}

function darwinKeychain(): KeychainBackend {
  return {
    get() {
      try {
        return execFileSync(
          "security",
          [
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
      } catch {
        return null;
      }
    },
    set(value: string) {
      try {
        execFileSync(
          "security",
          [
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            value,
          ],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

function defaultKeychain(): KeychainBackend | null {
  return os.platform() === "darwin" ? darwinKeychain() : null;
}

function readKeyFile(): Hex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(keyFilePath(), "utf8")) as {
      privateKey?: string;
    };
    return raw.privateKey && KEY_PATTERN.test(raw.privateKey)
      ? (raw.privateKey as Hex)
      : null;
  } catch {
    return null;
  }
}

function writeKeyFile(privateKey: Hex): void {
  fs.mkdirSync(getVanaHome(), { recursive: true });
  fs.writeFileSync(keyFilePath(), JSON.stringify({ privateKey }) + "\n", {
    mode: 0o600,
  });
}

function writeAddressPointer(address: Address, source: AppKeySource): void {
  try {
    fs.mkdirSync(getVanaHome(), { recursive: true });
    fs.writeFileSync(addressFilePath(), `${address} ${source}\n`);
  } catch {
    // The pointer is a convenience; never fail resolution over it.
  }
}

/** Nonsecret pointer for display surfaces; null when no key has been used. */
export function readAppKeyPointer(): {
  address: Address;
  source: string;
} | null {
  try {
    const [address, source] = fs
      .readFileSync(addressFilePath(), "utf8")
      .trim()
      .split(" ");
    return address ? { address: address as Address, source } : null;
  } catch {
    return null;
  }
}

export interface ResolveAppKeyOptions {
  /** Generate and store a key when none exists. Default false. */
  allowGenerate?: boolean;
  env?: Record<string, string | undefined>;
  keychain?: KeychainBackend | null;
}

/**
 * Resolve the builder key, or throw {@link AppKeyMissingError} when none
 * exists and generation is not allowed.
 */
export function resolveAppKey(
  options: ResolveAppKeyOptions = {},
): ResolvedAppKey {
  const env = options.env ?? process.env;
  const keychain =
    options.keychain === undefined ? defaultKeychain() : options.keychain;

  const fromEnv = env[ENV_VAR];
  if (fromEnv) {
    if (!KEY_PATTERN.test(fromEnv)) {
      throw new InvalidAppKeyError(ENV_VAR);
    }
    return toResolved(fromEnv as Hex, "env");
  }

  const fromKeychain = keychain?.get() ?? null;
  if (fromKeychain) {
    if (!KEY_PATTERN.test(fromKeychain)) {
      throw new InvalidAppKeyError("keychain entry");
    }
    const resolved = toResolved(fromKeychain as Hex, "keychain");
    writeAddressPointer(resolved.address, resolved.source);
    return resolved;
  }

  const fromFile = readKeyFile();
  if (fromFile) {
    const resolved = toResolved(fromFile, "file");
    writeAddressPointer(resolved.address, resolved.source);
    return resolved;
  }

  if (!options.allowGenerate) {
    throw new AppKeyMissingError();
  }

  const privateKey = generatePrivateKey();
  const stored = keychain?.set(privateKey) ?? false;
  if (!stored) {
    writeKeyFile(privateKey);
  }
  const resolved = toResolved(privateKey, "generated");
  writeAddressPointer(resolved.address, stored ? "keychain" : "file");
  return resolved;
}
