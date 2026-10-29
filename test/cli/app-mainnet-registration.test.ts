import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Builder, type GatewayClient } from "@opendatalabs/vana-sdk";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AppKeyMissingError,
  type ResolvedAppKey,
} from "../../src/core/app-key.js";
import { readAppProfile, saveAppProfile } from "../../src/core/app-profile.js";
import { resolveNetwork } from "../../src/core/network.js";
import { createAppRegistrationStore } from "../../src/core/app-registration-store.js";
import {
  runAppRegister,
  type RegisterDeps,
} from "../../src/cli/app/register.js";

const privateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(privateKey);
const key: ResolvedAppKey = {
  privateKey,
  address: account.address,
  publicKey: account.publicKey,
  source: "env",
};
const subject = "vana_user_0123456789abcdef0123456789abcdef";
const options = {
  network: "mainnet",
  appUrl: "https://production.example",
  appName: "Example",
  json: true,
} as const;
const mainnet = resolveNetwork("mainnet", {});
const moksha = resolveNetwork("moksha", {});
let directory: string;
let output: string;
let builder: Builder | null;
let owned: boolean;
let unavailable: boolean;
let wrongAccount: boolean;
let lostRegistrationResponse: boolean;
let registrations: number;
let deps: RegisterDeps;
let accountOrigin: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "mainnet-registration-"));
  vi.stubEnv("VANA_HOME", directory);
  vi.stubEnv("VANA_ENV", "prod");
  vi.stubEnv("VANA_ACCOUNT_URL", "https://account.vana.org");
  accountOrigin = "https://account.vana.org";
  output = "";
  builder = null;
  owned = unavailable = wrongAccount = lostRegistrationResponse = false;
  registrations = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += chunk;
    return true;
  });
  const source: Builder = {
    id: "existing",
    ownerAddress: account.address,
    granteeAddress: account.address,
    publicKey: account.publicKey,
    appUrl: "http://localhost:3000",
    addedAt: "2026-01-01",
  };
  deps = {
    resolveKey: () => key,
    store: createAppRegistrationStore(path.join(directory, "requests.json")),
    loadCredentials: () => ({
      account: {
        address: "0x1111111111111111111111111111111111111111",
        session_token: "synthetic-account-token",
        expires_at: "2099-01-01",
      },
      personal_server: null,
    }),
    createClient: (url) =>
      ({
        getBuilder: async () => (url === mainnet.gatewayUrl ? builder : source),
        registerBuilder: async (params) => {
          registrations += 1;
          builder = { ...source, appUrl: params.appUrl };
          if (lostRegistrationResponse) throw new Error("response lost");
          return { alreadyRegistered: false, builderId: "mainnet-app" };
        },
      }) as GatewayClient,
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.origin === mainnet.gatewayUrl) {
        return Response.json({ data: builder, proof: { status: "confirmed" } });
      }
      if (parsed.origin !== accountOrigin)
        throw new Error("Wrong Account deployment");
      if (parsed.pathname === "/api/v1/me/app-ownership") {
        const network = parsed.searchParams.get("network");
        return Response.json({
          object: "app_ownership",
          appAddress: account.address.toLowerCase(),
          network,
          subject,
          ownership: wrongAccount
            ? "not_owned"
            : network === "moksha" || owned
              ? "owned"
              : "not_owned",
        });
      }
      if (parsed.pathname !== "/api/v1/me/app-registrations")
        throw new Error("Unexpected human handoff or network call");
      if (unavailable)
        return Response.json(
          { error: { code: "account_inventory_unavailable" } },
          { status: 503 },
        );
      const body = JSON.parse(String(init?.body));
      // Independent Account wire contract, including subject, origin and chain.
      const valid = await verifyTypedData({
        address: account.address,
        domain: {
          name: "Vana Data Portability",
          version: "1",
          chainId: 1480,
          verifyingContract: "0x8325C0A0948483EdA023A1A2Fd895e62C5131234",
        },
        types: {
          BuilderNetworkAssociation: [
            { name: "granteeAddress", type: "address" },
            { name: "accountSubject", type: "string" },
            { name: "accountOrigin", type: "string" },
            { name: "sourceNetwork", type: "string" },
            { name: "network", type: "string" },
            { name: "appUrl", type: "string" },
            { name: "appName", type: "string" },
            { name: "expiry", type: "uint64" },
          ],
        },
        primaryType: "BuilderNetworkAssociation",
        message: {
          granteeAddress: account.address,
          accountSubject: subject,
          accountOrigin,
          sourceNetwork: "moksha",
          network: "mainnet",
          appUrl: options.appUrl,
          appName: options.appName,
          expiry: BigInt(body.expiry),
        },
        signature: body.signature,
      });
      if (!valid) return Response.json({}, { status: 400 });
      owned = true;
      return Response.json({});
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
const outcome = () => JSON.parse(output.trim().split("\n").at(-1)!);

describe("one-command mainnet registration", () => {
  it("reuses the same app and Account without a claim and preserves Moksha metadata", async () => {
    saveAppProfile(
      account.address,
      { name: "Test app", url: "http://localhost:3000" },
      moksha,
    );
    expect(await runAppRegister(options, deps)).toBe(0);
    expect(outcome()).toMatchObject({
      status: "done",
      data: {
        address: account.address.toLowerCase(),
        subject,
        ownership: "owned",
        appUrl: options.appUrl,
      },
    });
    expect(registrations).toBe(1);
    expect(readAppProfile(account.address, moksha)).toEqual({
      name: "Test app",
      url: "http://localhost:3000",
    });
    expect(readAppProfile(account.address, mainnet)).toEqual({
      name: "Example",
      url: options.appUrl,
    });
    expect(deps.store!.getRegistration()).toBeNull();
  });
  it("resumes against dev Account without overwriting production metadata", async () => {
    vi.stubEnv("VANA_ENV", "dev");
    accountOrigin = "https://account-dev.vana.org";
    vi.stubEnv("VANA_ACCOUNT_URL", accountOrigin);
    saveAppProfile(
      account.address,
      { name: "Production app", url: "https://unchanged.example" },
      mainnet,
    );
    unavailable = true;
    expect(await runAppRegister(options, deps)).toBe(6);
    expect(deps.store!.getRegistration()).toMatchObject({
      env: "dev",
      accountUrl: accountOrigin,
    });
    unavailable = false;
    expect(await runAppRegister(options, deps)).toBe(0);
    expect(registrations).toBe(1);
    expect(
      readAppProfile(
        account.address,
        resolveNetwork("mainnet", { VANA_ENV: "dev" }),
      ),
    ).toEqual({ name: "Example", url: options.appUrl });
    expect(readAppProfile(account.address, mainnet)).toEqual({
      name: "Production app",
      url: "https://unchanged.example",
    });
    expect(deps.store!.getRegistration()).toBeNull();
  });
  it("waits for the gateway's pending proof in one invocation before asking Account to associate", async () => {
    vi.useFakeTimers();
    try {
      const request = deps.fetch!;
      let confirmationReads = 0;
      let pendingProof = true;
      let associationAttempts = 0;
      deps.fetch = async (url, init) => {
        const target = new URL(String(url));
        if (target.origin === mainnet.gatewayUrl) {
          pendingProof = ++confirmationReads < 3;
          return Response.json({
            data: builder,
            proof: { status: pendingProof ? "pending" : "confirmed" },
          });
        }
        if (target.pathname === "/api/v1/me/app-registrations") {
          associationAttempts += 1;
          if (pendingProof)
            return Response.json(
              { error: { code: "gateway_unavailable" } },
              { status: 503 },
            );
        }
        return request(url, init);
      };
      const pending = runAppRegister(options, deps);
      await vi.runAllTimersAsync();
      expect(await pending).toBe(0);
      expect(outcome()).toMatchObject({
        status: "done",
        data: { ownership: "owned" },
      });
      expect(output.trim().split("\n")).toHaveLength(1);
      expect(registrations).toBe(1);
      expect(confirmationReads).toBe(3);
      expect(associationAttempts).toBe(1);
      expect(deps.store!.getRegistration()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains the operation when confirmation stays pending, without asking Account or registering twice", async () => {
    vi.useFakeTimers();
    try {
      const request = deps.fetch!;
      let associationAttempts = 0;
      deps.fetch = async (url, init) => {
        const target = new URL(String(url));
        if (target.origin === mainnet.gatewayUrl)
          return Response.json({ data: builder, proof: { status: "pending" } });
        if (target.pathname === "/api/v1/me/app-registrations")
          associationAttempts += 1;
        return request(url, init);
      };
      const pending = runAppRegister(options, deps);
      await vi.runAllTimersAsync();
      expect(await pending).toBe(6);
      expect(outcome().code).toBe("not_ready");
      expect(registrations).toBe(1);
      expect(associationAttempts).toBe(0);
      expect(deps.store!.getRegistration()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["failed", "changed-owner"])(
    "does not associate a %s confirmation",
    async (confirmation) => {
      const request = deps.fetch!;
      let associations = 0;
      deps.fetch = async (url, init) => {
        const target = new URL(String(url));
        if (target.origin === mainnet.gatewayUrl) {
          return Response.json({
            data:
              confirmation === "changed-owner"
                ? {
                    ...builder,
                    ownerAddress: "0x1111111111111111111111111111111111111111",
                  }
                : builder,
            proof: {
              status: confirmation === "failed" ? "failed" : "confirmed",
            },
          });
        }
        if (target.pathname === "/api/v1/me/app-registrations")
          associations += 1;
        return request(url, init);
      };
      expect(await runAppRegister(options, deps)).toBe(
        confirmation === "failed" ? 6 : 2,
      );
      expect(associations).toBe(0);
      expect(registrations).toBe(1);
      expect(deps.store!.getRegistration()).not.toBeNull();
    },
  );
  it("resumes Account association after gateway success without registering again", async () => {
    unavailable = true;
    expect(await runAppRegister(options, deps)).toBe(6);
    expect(outcome().data.partial).toBe(true);
    expect(deps.store!.getRegistration()).toMatchObject({
      subject,
      appAddress: account.address.toLowerCase(),
    });
    unavailable = false;
    expect(await runAppRegister(options, deps)).toBe(0);
    expect(registrations).toBe(1);
  });
  it("reconciles a scoped production association even when legacy ownership already projects as owned", async () => {
    owned = true;
    unavailable = true;
    expect(await runAppRegister(options, deps)).toBe(6);
    expect(deps.store!.getRegistration()).not.toBeNull();
    unavailable = false;
    expect(await runAppRegister(options, deps)).toBe(0);
    expect(registrations).toBe(1);
  });
  it("recovers a lost gateway response by reading the existing registration", async () => {
    lostRegistrationResponse = true;
    expect(await runAppRegister(options, deps)).toBe(6);
    expect(await runAppRegister(options, deps)).toBe(0);
    expect(registrations).toBe(1);
  });
  it("refuses another Account before creating a mainnet registration", async () => {
    wrongAccount = true;
    expect(await runAppRegister(options, deps)).toBe(1);
    expect(registrations).toBe(0);
    expect(outcome().code).toBe("builder_unknown");
  });
  it("retains the original key and production URL after interruption", async () => {
    unavailable = true;
    await runAppRegister(options, deps);
    expect(
      await runAppRegister(
        { ...options, appUrl: "https://changed.example" },
        deps,
      ),
    ).toBe(2);
    const other = privateKeyToAccount(`0x${"12".repeat(32)}`);
    deps.resolveKey = () => ({
      ...key,
      address: other.address,
      publicKey: other.publicKey,
    });
    expect(await runAppRegister(options, deps)).toBe(2);
    expect(registrations).toBe(1);
  });
  it("returns human action required for missing authentication without creating a registration", async () => {
    deps.loadCredentials = () => null;
    expect(await runAppRegister(options, deps)).toBe(7);
    expect(outcome().code).toBe("confirmation_required");
    expect(registrations).toBe(0);
  });
  it("never generates a replacement mainnet key", async () => {
    deps.resolveKey = (input) => {
      expect(input?.allowGenerate).toBe(false);
      throw new AppKeyMissingError();
    };
    expect(await runAppRegister(options, deps)).toBe(1);
    expect(registrations).toBe(0);
  });
});
