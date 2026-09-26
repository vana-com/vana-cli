import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "@opendatalabs/vana-sdk";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BUILDER_CLAIM_LINK_TYPES,
  CLAIM_LINK_TTL_SEC,
  buildClaimLink,
  runAppClaim,
} from "../../src/cli/app/claim.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";
import { builderRegistrationDomainFor } from "../../src/cli/app/register.js";
import {
  AppKeyMissingError,
  type ResolvedAppKey,
} from "../../src/core/app-key.js";
import { resolveNetwork } from "../../src/core/network.js";

const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);
const resolvedKey: ResolvedAppKey = {
  privateKey: KEY,
  address: account.address,
  publicKey: account.publicKey,
  source: "file",
};

function clientWith(registered: boolean | Error): () => GatewayClient {
  return () =>
    ({
      isRegisteredBuilder: async () => {
        if (registered instanceof Error) throw registered;
        return registered;
      },
    }) as unknown as GatewayClient;
}

let stdout: string;

beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildClaimLink", () => {
  it("signs a BuilderClaimLink that Account can verify from the URL alone", async () => {
    const network = resolveNetwork("mainnet");
    const link = await buildClaimLink({
      privateKey: KEY,
      network,
      nowSec: 1_790_000_000,
      nonce: `0x${"ab".repeat(32)}`,
    });

    const url = new URL(link.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://account.vana.org/developers/apps/claim",
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      network: "mainnet",
      address: account.address.toLowerCase(),
      nonce: `0x${"ab".repeat(32)}`,
      expiry: String(1_790_000_000 + CLAIM_LINK_TTL_SEC),
    });
    const valid = await verifyTypedData({
      address: params.address as `0x${string}`,
      domain: builderRegistrationDomainFor(network),
      types: BUILDER_CLAIM_LINK_TYPES,
      primaryType: "BuilderClaimLink",
      message: {
        granteeAddress: params.address as `0x${string}`,
        network: params.network,
        nonce: params.nonce as `0x${string}`,
        expiry: BigInt(params.expiry),
      },
      signature: params.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it("stays inside Account's one-hour window", () => {
    expect(CLAIM_LINK_TTL_SEC).toBeLessThan(60 * 60);
  });

  it("uses a fresh nonce each time", async () => {
    const network = resolveNetwork("mainnet");
    const a = new URL((await buildClaimLink({ privateKey: KEY, network })).url);
    const b = new URL((await buildClaimLink({ privateKey: KEY, network })).url);
    expect(a.searchParams.get("nonce")).not.toBe(b.searchParams.get("nonce"));
  });
});

describe("vana app claim", () => {
  it("prints the claim link and the fund page", async () => {
    const openUrl = vi.fn();
    const exitCode = await runAppClaim(
      { json: true, network: "mainnet" },
      {
        resolveKey: () => resolvedKey,
        createClient: clientWith(true),
        openUrl,
      },
    );

    expect(exitCode).toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(String(outcome.data?.claimUrl)).toMatch(
      /^https:\/\/account\.vana\.org\/developers\/apps\/claim\?network=mainnet&address=0x/,
    );
    expect(outcome.data?.fundUrl).toBe(
      `https://account.vana.org/developers/apps/mainnet/${account.address.toLowerCase()}/fund`,
    );
    // JSON mode is for agents: never pops a browser.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens the link for a person at a terminal", async () => {
    const openUrl = vi.fn();
    await runAppClaim(
      { network: "mainnet" },
      {
        resolveKey: () => resolvedKey,
        createClient: clientWith(true),
        openUrl,
        isTty: true,
      },
    );

    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining("/developers/apps/claim?"),
    );
    expect(stdout).toContain("claimUrl: https://account.vana.org/");
  });

  it("still prints a link when the gateway can't be reached", async () => {
    const exitCode = await runAppClaim(
      { json: true, network: "mainnet" },
      {
        resolveKey: () => resolvedKey,
        createClient: clientWith(new Error("offline")),
        openUrl: vi.fn(),
      },
    );

    expect(exitCode).toBe(0);
  });

  it("points an unregistered app at register", async () => {
    const exitCode = await runAppClaim(
      { json: true, network: "mainnet" },
      {
        resolveKey: () => resolvedKey,
        createClient: clientWith(false),
        openUrl: vi.fn(),
      },
    );

    expect(exitCode).not.toBe(0);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.code).toBe("builder_unknown");
    expect(outcome.remedy).toBe("vana app register");
  });

  it("points a machine with no app key at register", async () => {
    const exitCode = await runAppClaim(
      { json: true, network: "mainnet" },
      {
        resolveKey: () => {
          throw new AppKeyMissingError();
        },
      },
    );

    expect(exitCode).not.toBe(0);
    expect(appOutcomeSchema.parse(JSON.parse(stdout)).remedy).toBe(
      "vana app register",
    );
  });
});
