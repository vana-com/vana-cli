import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { GatewayClient } from "@opendatalabs/vana-sdk";
import { runAppClaim } from "../../src/cli/app/claim.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";

const privateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const app = privateKeyToAccount(privateKey);
const subject = `vana_user_${"a".repeat(32)}`;
let directory: string;
let stdout: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "vana-claim-proof-"));
  vi.stubEnv("VANA_HOME", directory);
  vi.stubEnv("VANA_ENV", "dev");
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    stdout += String(value);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const state = { owned: false, subject, status: 200 };
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://account-dev.vana.org/api/v1/me/app-ownership?address=${app.address.toLowerCase()}&network=moksha`,
      );
      expect(init?.headers).toEqual({
        authorization: "Bearer fixture-account-token",
      });
      return new Response(
        JSON.stringify({
          object: "app_ownership",
          appAddress: app.address.toLowerCase(),
          network: "moksha",
          subject: state.subject,
          ownership: state.owned ? "owned" : "not_owned",
        }),
        { status: state.status },
      );
    },
  );
  const openUrl = vi.fn();
  const deps = {
    resolveKey: () => ({
      privateKey,
      address: app.address,
      publicKey: app.publicKey,
      source: "file" as const,
    }),
    createClient: () =>
      ({ isRegisteredBuilder: async () => true }) as GatewayClient,
    readProfile: () => ({ name: "Garden" }),
    loadCredentials: () => ({
      account: {
        address: "env",
        session_token: "fixture-account-token",
        expires_at: "2099-01-01T00:00:00Z",
      },
      personal_server: null,
    }),
    fetch: request,
    openUrl,
    isTty: true,
    sleep: async () => {},
  };
  return { state, deps, openUrl };
}

function outcome() {
  const result = appOutcomeSchema.parse(JSON.parse(stdout));
  stdout = "";
  return result;
}

it("fresh claim reports success only after the Account browser step confirms ownership", async () => {
  const { state, deps, openUrl } = fixture();
  openUrl.mockImplementation(() => {
    state.owned = true;
  });
  expect(await runAppClaim({ network: "moksha" }, deps)).toBe(0);
  expect(stdout).toContain("registered and linked to your Account");
  expect(openUrl).toHaveBeenCalledOnce();
});

it("repeat confirms the existing Account link without another browser claim", async () => {
  const { state, deps, openUrl } = fixture();
  state.owned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await runAppClaim({ network: "moksha", json: true }, deps)).toBe(0);
    expect(outcome().data).toMatchObject({
      address: app.address.toLowerCase(),
      subject,
      ownership: "owned",
    });
  }
  expect(openUrl).not.toHaveBeenCalled();
});

it("interrupted claim resumes its saved link and confirms completion without a replacement claim", async () => {
  const { state, deps, openUrl } = fixture();
  const options = { network: "moksha" as const, json: true, noInput: true };
  expect(await runAppClaim(options, deps)).toBe(7);
  const first = outcome();
  expect(first.data?.ownership).toBe("not_owned");
  expect(first.remedy).toContain("--resume");
  expect(await runAppClaim({ ...options, resume: true }, deps)).toBe(7);
  expect(outcome().data?.claimUrl).toBe(first.data?.claimUrl);
  state.owned = true;
  expect(await runAppClaim({ ...options, resume: true }, deps)).toBe(0);
  expect(outcome().data).toMatchObject({ subject, ownership: "owned" });
  state.subject = `vana_user_${"b".repeat(32)}`;
  expect(await runAppClaim({ ...options, resume: true }, deps)).toBe(2);
  expect(outcome().message).toContain("different Account");
  expect(openUrl).not.toHaveBeenCalled();
});

it.each([
  [401, 7],
  [403, 6],
  [503, 6],
])(
  "Account HTTP %s cannot be mistaken for a completed claim",
  async (status, exitCode) => {
    const { state, deps, openUrl } = fixture();
    state.status = status;
    state.owned = true;
    expect(await runAppClaim({ network: "moksha", json: true }, deps)).toBe(
      exitCode,
    );
    expect(outcome().status).toBe("failed");
    expect(openUrl).not.toHaveBeenCalled();
  },
);

it("an invalid Account reply remains unconfirmed and can be retried without a saved claim", async () => {
  const { deps } = fixture();
  deps.fetch.mockImplementationOnce(async () => Response.json(null));
  expect(await runAppClaim({ network: "moksha", json: true }, deps)).toBe(6);
  const pending = outcome();
  expect(pending.remedy).not.toContain("--resume");
  expect(pending.status).toBe("failed");
});
