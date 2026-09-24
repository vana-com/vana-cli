import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { localServerHome } from "./config.js";
import type { OwnerBinding } from "./owner-binding.js";

/**
 * Where the owner-binding signature is kept between starts, so starting a
 * server does not ask for a browser confirmation every time. It derives the
 * server's encryption key, so on macOS it lives in the keychain; elsewhere in
 * a 0600 file, as the app key does.
 */
export interface OwnerSecretStore {
  get(key: string): OwnerBinding | null;
  set(key: string, binding: OwnerBinding): void;
  delete(key: string): void;
}

const KEYCHAIN_SERVICE = "org.vana.cli.personal-server-owner";

export function ownerSecretKey(accountUrl: string, address: string): string {
  return `${new URL(accountUrl).host}:${address.toLowerCase()}`;
}

function parse(raw: string | null | undefined): OwnerBinding | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OwnerBinding>;
    if (
      typeof value.signature === "string" &&
      typeof value.signerAddress === "string"
    ) {
      return {
        signature: value.signature,
        signerAddress: value.signerAddress,
        trustToken:
          typeof value.trustToken === "string" ? value.trustToken : null,
      };
    }
  } catch {
    // Unreadable entry: treat as absent.
  }
  return null;
}

function keychainStore(): OwnerSecretStore {
  const run = (args: string[]) =>
    execFileSync("security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  return {
    get(key) {
      try {
        return parse(
          run([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            key,
            "-w",
          ]).trim(),
        );
      } catch {
        return null;
      }
    },
    set(key, binding) {
      run([
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        key,
        "-w",
        JSON.stringify(binding),
      ]);
    },
    delete(key) {
      try {
        run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key]);
      } catch {
        // Already gone.
      }
    },
  };
}

function fileStore(
  file = path.join(localServerHome(), "owner-bindings.json"),
): OwnerSecretStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  };
  const write = (entries: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, {
      mode: 0o600,
    });
  };
  return {
    get: (key) => parse(read()[key]),
    set(key, binding) {
      write({ ...read(), [key]: JSON.stringify(binding) });
    },
    delete(key) {
      const entries = read();
      delete entries[key];
      write(entries);
    },
  };
}

// Without a default keychain (a HOME with no login keychain, a fresh
// account), `security add-generic-password` does not fail: it puts up a GUI
// dialog and waits. Asking for the default keychain never prompts.
function hasDefaultKeychain(): boolean {
  try {
    execFileSync("security", ["default-keychain"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function defaultOwnerSecretStore(): OwnerSecretStore {
  return process.platform === "darwin" && hasDefaultKeychain()
    ? keychainStore()
    : fileStore();
}

export { fileStore as fileOwnerSecretStore };
