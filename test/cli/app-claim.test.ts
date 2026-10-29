import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { readAppProfile } from "../../src/core/app-profile.js";

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
let claimHome: string;
const accountDeps = {
  loadCredentials: () => ({
    account: {
      address: "env",
      session_token: "fixture-account-token",
      expires_at: "2099-01-01T00:00:00Z",
    },
    personal_server: null,
  }),
  fetch: async () =>
    new Response(
      JSON.stringify({
        object: "app_ownership",
        appAddress: account.address.toLowerCase(),
        network: "mainnet",
        subject: `vana_user_${"a".repeat(32)}`,
        ownership: "not_owned",
      }),
    ),
};

beforeEach(() => {
  claimHome = fs.mkdtempSync(path.join(os.tmpdir(), "vana-claim-link-"));
  vi.stubEnv("VANA_HOME", claimHome);
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
  fs.rmSync(claimHome, { recursive: true, force: true });
});

describe("buildClaimLink", () => {
  it("signs a BuilderClaimLink that Account can verify from the URL alone", async () => {
    const network = resolveNetwork("mainnet");
    const link = await buildClaimLink({
      privateKey: KEY,
      network,
      appName: "Hermes Agent",
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
      name: "Hermes Agent",
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
        appName: params.name,
      },
      signature: params.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it("stays inside Account's one-hour window", () => {
    expect(CLAIM_LINK_TTL_SEC).toBeLessThan(60 * 60);
  });

  it("signs an empty name and leaves it out of the URL when the app has none", async () => {
    const network = resolveNetwork("mainnet");
    const url = new URL(
      (await buildClaimLink({ privateKey: KEY, network })).url,
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params.name).toBeUndefined();
    const valid = await verifyTypedData({
      address: account.address,
      domain: builderRegistrationDomainFor(network),
      types: BUILDER_CLAIM_LINK_TYPES,
      primaryType: "BuilderClaimLink",
      message: {
        granteeAddress: params.address as `0x${string}`,
        network: params.network,
        nonce: params.nonce as `0x${string}`,
        expiry: BigInt(params.expiry),
        appName: "",
      },
      signature: params.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
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
        ...accountDeps,
        resolveKey: () => resolvedKey,
        createClient: clientWith(true),
        readProfile: () => ({ name: "Hermes Agent" }),
        openUrl,
      },
    );

    expect(exitCode).toBe(7);
    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(String(outcome.data?.claimUrl)).toMatch(
      /^https:\/\/account\.vana\.org\/developers\/apps\/claim\?network=mainnet&address=0x/,
    );
    expect(outcome.data?.fundUrl).toBe(
      `https://account.vana.org/developers/apps/mainnet/${account.address.toLowerCase()}/fund`,
    );
    expect(outcome.data?.appName).toBe("Hermes Agent");
    expect(String(outcome.data?.claimUrl)).toContain("name=Hermes+Agent");
    // JSON mode is for agents: never pops a browser.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("uses and remembers --app-name over the saved name", async () => {
    await runAppClaim(
      { json: true, network: "mainnet", appName: "My Agent" },
      {
        ...accountDeps,
        resolveKey: () => resolvedKey,
        createClient: clientWith(true),
        readProfile: () => ({ name: "Hermes Agent" }),
        openUrl: vi.fn(),
      },
    );

    const outcome = appOutcomeSchema.parse(JSON.parse(stdout));
    expect(outcome.data?.appName).toBe("My Agent");
    expect(readAppProfile(account.address)).toMatchObject({
      name: "My Agent",
    });
  });

  it("opens the link for a person at a terminal", async () => {
    const openUrl = vi.fn();
    await runAppClaim(
      { network: "mainnet", timeout: "0" },
      {
        ...accountDeps,
        resolveKey: () => resolvedKey,
        createClient: clientWith(true),
        openUrl,
        isTty: true,
      },
    );

    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining("/developers/apps/claim?"),
    );
  });

  it("cannot confirm registration when the gateway cannot be reached", async () => {
    const exitCode = await runAppClaim(
      { json: true, network: "mainnet" },
      {
        ...accountDeps,
        resolveKey: () => resolvedKey,
        createClient: clientWith(new Error("offline")),
        openUrl: vi.fn(),
      },
    );

    expect(exitCode).toBe(6);
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
