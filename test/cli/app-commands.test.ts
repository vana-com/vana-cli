import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "@opendatalabs/vana-sdk";
import { verifyTypedData } from "viem";
import { runAppRegister } from "../../src/cli/app/register.js";
import { runAppWhoami } from "../../src/cli/app/whoami.js";
import { appOutcomeSchema, emitAppOutcome } from "../../src/cli/app/outcome.js";
import { builderRegistrationDomainFor } from "../../src/cli/app/register.js";
import { BUILDER_REGISTRATION_TYPES } from "@opendatalabs/vana-sdk";
import { resolveNetwork } from "../../src/core/network.js";
import {
  AppKeyMissingError,
  type ResolvedAppKey,
} from "../../src/core/app-key.js";
import { privateKeyToAccount } from "viem/accounts";

const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);

const resolvedKey: ResolvedAppKey = {
  privateKey: KEY,
  address: account.address,
  publicKey: account.publicKey,
  source: "env",
};

function clientWith(overrides: Partial<GatewayClient>): GatewayClient {
  return overrides as GatewayClient;
}

let stdout: string;
let stderr: string;

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vana app register", () => {
  it("exits 0 without posting when already registered", async () => {
    const registerBuilder = vi.fn();
    const exitCode = await runAppRegister(
      { json: true },
      {
        resolveKey: () => resolvedKey,
        createClient: () =>
          clientWith({
            isRegisteredBuilder: async () => true,
            registerBuilder,
          }),
      },
    );
    expect(exitCode).toBe(0);
    expect(registerBuilder).not.toHaveBeenCalled();
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.status).toBe("done");
    expect(outcome.data).toMatchObject({
      alreadyRegistered: true,
      address: account.address,
    });
  });

  it("signs a verifiable EIP-712 registration and posts it", async () => {
    let posted: Record<string, string> | undefined;
    const exitCode = await runAppRegister(
      { json: true, network: "moksha" },
      {
        resolveKey: () => resolvedKey,
        createClient: () =>
          clientWith({
            isRegisteredBuilder: async () => false,
            registerBuilder: async (params) => {
              posted = params as unknown as Record<string, string>;
              return { builderId: "b-1", alreadyRegistered: false };
            },
          }),
      },
    );
    expect(exitCode).toBe(0);
    expect(posted).toBeDefined();
    expect(posted?.ownerAddress).toBe(account.address);
    expect(posted?.publicKey).toBe(account.publicKey);

    const network = resolveNetwork("moksha", {});
    const valid = await verifyTypedData({
      address: account.address,
      domain: builderRegistrationDomainFor(network),
      types: BUILDER_REGISTRATION_TYPES,
      primaryType: "BuilderRegistration",
      message: {
        ownerAddress: posted?.ownerAddress as `0x${string}`,
        granteeAddress: posted?.granteeAddress as `0x${string}`,
        publicKey: posted?.publicKey as string,
        appUrl: posted?.appUrl as string,
      },
      signature: posted?.signature as `0x${string}`,
    });
    expect(valid).toBe(true);

    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({ builderId: "b-1" });
  });

  it("maps gateway failures to exit 1 with a gateway_unreachable code", async () => {
    const exitCode = await runAppRegister(
      { json: true },
      {
        resolveKey: () => resolvedKey,
        createClient: () =>
          clientWith({
            isRegisteredBuilder: async () => {
              throw new Error("fetch failed");
            },
          }),
      },
    );
    expect(exitCode).toBe(1);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("gateway_unreachable");
    expect(outcome.status).toBe("failed");
  });

  it("rejects an unknown network with exit 2", async () => {
    const exitCode = await runAppRegister(
      { json: true, network: "goerli" as never },
      { resolveKey: () => resolvedKey },
    );
    expect(exitCode).toBe(2);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe("bad_usage");
  });
});

describe("vana app whoami", () => {
  it("reports identity and registration state", async () => {
    const exitCode = await runAppWhoami(
      { json: true },
      {
        resolveKey: () => resolvedKey,
        createClient: () =>
          clientWith({ isRegisteredBuilder: async () => true }),
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data).toMatchObject({
      address: account.address,
      keySource: "env",
      registered: true,
      chainId: 14800,
    });
  });

  it("stays exit 0 with a remedy when no key exists", async () => {
    const exitCode = await runAppWhoami(
      { json: true },
      {
        resolveKey: () => {
          throw new AppKeyMissingError();
        },
      },
    );
    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.remedy).toBe("vana app register");
    expect(outcome.data).toMatchObject({ address: null });
  });

  it("reports registered unknown when the gateway is down", async () => {
    const exitCode = await runAppWhoami(
      { json: true },
      {
        resolveKey: () => resolvedKey,
        createClient: () =>
          clientWith({
            isRegisteredBuilder: async () => {
              throw new Error("offline");
            },
          }),
      },
    );
    expect(exitCode).toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).data).toMatchObject({
      registered: "unknown",
    });
  });
});

describe("emitAppOutcome human mode", () => {
  it("writes failures to stderr with the remedy", () => {
    const exitCode = emitAppOutcome(
      {},
      {
        status: "failed",
        code: "payment_required",
        message: "Payment required.",
        remedy: "vana app escrow fund",
      },
    );
    expect(exitCode).toBe(4);
    expect(stderr).toContain("Payment required.");
    expect(stderr).toContain("vana app escrow fund");
    expect(stdout).toBe("");
  });
});
