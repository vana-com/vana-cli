import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);

// Builder identity for e2e runs. Set VANA_BUILDER_PRIVATE_KEY to use a
// builder that is registered in the target environment (required for the
// live relay e2e); otherwise a throwaway key is generated (fine for local
// relays that auto-register, and for the graceful-skip path).
export const builderPrivateKey = (process.env.VANA_BUILDER_PRIVATE_KEY ??
  generatePrivateKey()) as `0x${string}`;
export const builderAccount = privateKeyToAccount(builderPrivateKey);

export function getSessionRelayUrl(): string {
  const url = process.env.SESSION_RELAY_URL;
  if (!url) {
    throw new Error(
      "SESSION_RELAY_URL environment variable is required for e2e tests",
    );
  }
  return url.replace(/\/$/, "");
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
