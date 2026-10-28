import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { Command } from "commander";
import { registerAppCommands } from "../../src/cli/app/index.js";
import { runAppRequest } from "../../src/cli/app/request.js";
import { createRequestsStore } from "../../src/core/requests-store.js";
import { appOutcomeSchema } from "../../src/cli/app/outcome.js";
import {
  runAppRequestsList,
  runAppRequestsShow,
} from "../../src/cli/app/requests.js";

const privateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(privateKey);
const key = {
  privateKey,
  address: account.address,
  publicKey: account.publicKey,
  source: "env" as const,
};
let home: string;
let stdout: string;
let accepted: Map<string, string>;
let bodies: string[];
let lost: boolean;
let status: string;
let statusScopes: string[];
let durableAtSend: boolean[];
let exitCode: typeof process.exitCode;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-consent-recovery-"));
  stdout = "";
  accepted = new Map();
  bodies = [];
  lost = true;
  status = "denied";
  statusScopes = ["github.repositories"];
  durableAtSend = [];
  vi.stubEnv("VANA_HOME", home);
  vi.stubEnv("VANA_ENV", "dev");
  vi.stubEnv("VANA_NETWORK", "moksha");
  exitCode = process.exitCode;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = String(init.body);
        bodies.push(body);
        const payload = JSON.parse(body);
        const journal = path.join(home, "requests.json");
        durableAtSend.push(
          fs.existsSync(journal) &&
            fs.statSync(journal).isFile() &&
            fs.readFileSync(journal, "utf8").includes(payload.idempotencyKey),
        );
        accepted.set(payload.idempotencyKey, "dcr_saved");
        if (lost) throw new Error("response lost after create");
        return Response.json({
          requestId: "dcr_saved",
          appAddress: account.address,
          approvalUrl: "https://app-dev.vana.org/approve/saved",
          expiresAt: "2099-01-01T00:00:00Z",
          network: "moksha",
        });
      }
      return Response.json({
        status,
        grantId:
          status === "approved"
            ? "0x1111111111111111111111111111111111111111111111111111111111111111"
            : undefined,
        scopes: statusScopes,
      });
    }),
  );
});

afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it("accepts --resume through the real command parser without overriding a saved --no-merge-grant", async () => {
  vi.stubEnv("VANA_APP_KEY", privateKey);
  const invoke = async (args: string[]) => {
    const program = new Command().exitOverride();
    registerAppCommands(program, () => ({
      json: true,
      noInput: true,
      network: "moksha",
    }));
    await program.parseAsync(["node", "vana", "app", "request", ...args]);
    return appOutcomeSchema.parse(JSON.parse(stdout));
  };
  const first = await invoke([
    "--scopes",
    "github.repositories",
    "--no-merge-grant",
  ]);
  expect(first.exitCode).toBe(6);
  stdout = "";
  lost = false;
  expect(
    (await invoke(["--resume", String(first.data?.setupId)])).exitCode,
  ).toBe(3);
  expect(bodies[1]).toBe(bodies[0]);
});

const store = () => createRequestsStore(path.join(home, "requests.json"));
const deps = () => ({
  resolveKey: () => key,
  readProfile: () => ({}),
  requests: store(),
});

it("persists the exact consent intent before POST and replays it after a lost response", async () => {
  expect(
    await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "github.repositories",
        appName: "Research Shelf",
      },
      deps(),
    ),
  ).toBe(6);
  const failed = appOutcomeSchema.parse(JSON.parse(stdout));
  const setupId = String(failed.data?.setupId);
  expect(setupId).toMatch(/^setup_/);
  const persisted = fs.readFileSync(path.join(home, "requests.json"), "utf8");
  expect(persisted).toContain(JSON.parse(bodies[0]).idempotencyKey);
  expect(failed.remedy).toContain(`--resume ${setupId}`);
  expect(failed.remedy).toContain("VANA_ENV=dev");
  stdout = "";
  lost = false;
  expect(
    await runAppRequest(
      { json: true, noInput: true, ...{ resume: setupId } },
      deps(),
    ),
  ).toBe(3);
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(accepted.size).toBe(1);
  expect(durableAtSend).toEqual([true, true]);
  expect(store().get("dcr_saved")?.status).toBe("denied");
  stdout = "";
  expect(
    await runAppRequest(
      { json: true, noInput: true, ...{ resume: setupId } },
      deps(),
    ),
  ).toBe(3);
  expect(bodies).toHaveLength(2);
});

async function interrupted() {
  await runAppRequest(
    {
      json: true,
      noInput: true,
      scopes: "github.repositories",
      mergeGrant: false,
      appName: "Research Shelf",
    },
    deps(),
  );
  const id = String(appOutcomeSchema.parse(JSON.parse(stdout)).data?.setupId);
  stdout = "";
  lost = false;
  return id;
}

it.each([
  { scopes: "github.issues" },
  { appName: "Another app" },
  { returnUrl: "https://another.example" },
  { mergeGrant: true },
  { question: "A different question" },
  { network: "mainnet" as const },
])(
  "refuses changed resume inputs %j without another create",
  async (changed) => {
    const setupId = await interrupted();
    expect(
      await runAppRequest(
        { json: true, noInput: true, resume: setupId, ...changed },
        deps(),
      ),
    ).toBe(2);
    expect(bodies).toHaveLength(1);
  },
);

it("refuses a different app or environment before a recovered POST", async () => {
  const setupId = await interrupted();
  expect(
    await runAppRequest(
      { json: true, resume: setupId },
      {
        ...deps(),
        resolveKey: () => ({
          ...key,
          address: "0x2222222222222222222222222222222222222222",
        }),
      },
    ),
  ).toBe(2);
  stdout = "";
  vi.stubEnv("VANA_ENV", "prod");
  expect(await runAppRequest({ json: true, resume: setupId }, deps())).toBe(2);
  expect(bodies).toHaveLength(1);
});

it("detects a changed saved payload and preserves the original uncertainty", async () => {
  const setupId = await interrupted();
  const file = path.join(home, "requests.json");
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  journal.intents[0].input.returnUrl = "https://changed.example";
  fs.writeFileSync(file, JSON.stringify(journal));
  expect(await runAppRequest({ json: true, resume: setupId }, deps())).toBe(1);
  expect(bodies).toHaveLength(1);
});

it("recovers its saved environment when no override was supplied", async () => {
  const setupId = await interrupted();
  delete process.env.VANA_ENV;
  delete process.env.VANA_NETWORK;
  expect(
    await runAppRequest({ json: true, noInput: true, resume: setupId }, deps()),
  ).toBe(3);
  expect(bodies[1]).toBe(bodies[0]);
});

it("lists and inspects an unfinished intent without creating consent", async () => {
  const setupId = await interrupted();
  expect(
    await runAppRequestsList({ json: true, network: "moksha" }, deps()),
  ).toBe(0);
  expect(appOutcomeSchema.parse(JSON.parse(stdout)).data?.setups).toEqual([
    expect.objectContaining({ setupId }),
  ]);
  stdout = "";
  expect(
    await runAppRequestsShow(
      setupId,
      { json: true, network: "moksha" },
      deps(),
    ),
  ).toBe(6);
  expect(bodies).toHaveLength(1);
});

it.each(["expired", "approved"])(
  "recovers %s status without another approval or replacement",
  async (terminal) => {
    const setupId = await interrupted();
    status = terminal;
    const getGrant = vi.fn(async () => ({
      scopes: statusScopes,
      revokedAt: null,
      expired: false,
    }));
    const options = { json: true, noInput: true, resume: setupId };
    const dependencies = { ...deps(), createClient: () => ({ getGrant }) };
    const code = terminal === "approved" ? 0 : 3;
    expect(await runAppRequest(options, dependencies)).toBe(code);
    expect(bodies).toHaveLength(2);
    stdout = "";
    expect(
      await runAppRequest(options, { ...dependencies, requests: store() }),
    ).toBe(code);
    expect(bodies).toHaveLength(2);
  },
);

it("does not call an approved grant current when the gateway cannot verify it", async () => {
  const setupId = await interrupted();
  status = "approved";
  expect(
    await runAppRequest(
      { json: true, noInput: true, resume: setupId },
      {
        ...deps(),
        createClient: () => ({
          getGrant: async () => {
            throw new Error("offline");
          },
        }),
      },
    ),
  ).toBe(6);
});

it("retains the same intent if saving the received remote ID fails", async () => {
  lost = false;
  expect(
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      {
        ...deps(),
        requests: {
          ...store(),
          save: () => {
            throw new Error("disk full");
          },
        },
      },
    ),
  ).toBe(1);
  const setupId = String(
    appOutcomeSchema.parse(JSON.parse(stdout)).data?.setupId,
  );
  stdout = "";
  expect(
    await runAppRequest({ json: true, noInput: true, resume: setupId }, deps()),
  ).toBe(3);
  expect(bodies[1]).toBe(bodies[0]);
  expect(accepted.size).toBe(1);
});

it("preserves an existing recovery intent when a new journal write is interrupted", async () => {
  const setupId = await interrupted();
  const write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file) => {
    write(file, '{"version":');
    throw new Error("interrupted write");
  });
  expect(
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      deps(),
    ),
  ).toBe(1);
  expect(bodies).toHaveLength(1);
  expect(store().getIntent(setupId)?.setupId).toBe(setupId);
  expect(fs.statSync(path.join(home, "requests.json")).mode & 0o777).toBe(
    0o600,
  );
});

it("leaves a failed same-key replay recoverable without choosing another key", async () => {
  const setupId = await interrupted();
  lost = true;
  expect(
    await runAppRequest({ json: true, noInput: true, resume: setupId }, deps()),
  ).toBe(6);
  expect(bodies[1]).toBe(bodies[0]);
  expect(store().getIntent(setupId)?.requestId).toBeUndefined();
  expect(accepted.size).toBe(1);
});

it("does not create a replacement when the original command is repeated after a lost response", async () => {
  const setupId = await interrupted();
  expect(
    await runAppRequest(
      {
        json: true,
        noInput: true,
        scopes: "github.repositories",
        mergeGrant: false,
        appName: "Research Shelf",
      },
      deps(),
    ),
  ).toBe(6);
  expect(bodies).toHaveLength(1);
  expect(appOutcomeSchema.parse(JSON.parse(stdout)).data?.setupId).toBe(
    setupId,
  );
});

it("emits one internal outcome when the known request lookup fails", async () => {
  const setupId = await interrupted();
  await runAppRequest({ json: true, noInput: true, resume: setupId }, deps());
  stdout = "";
  const code = await runAppRequest(
    { json: true, noInput: true, resume: setupId },
    {
      ...deps(),
      requests: {
        ...store(),
        get: () => {
          throw new Error("store became unreadable");
        },
      },
    },
  );
  expect(code).toBe(1);
  expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe("internal");
  expect(bodies).toHaveLength(2);
});

it("keeps the original approval scopes when a later grant replaced them", async () => {
  const setupId = await interrupted();
  status = "approved";
  const dependencies = {
    ...deps(),
    createClient: () => ({
      getGrant: async () => ({
        scopes: statusScopes,
        revokedAt: null,
        expired: false,
      }),
    }),
  };
  expect(
    await runAppRequest(
      { json: true, noInput: true, resume: setupId },
      dependencies,
    ),
  ).toBe(0);
  statusScopes = ["github.issues"];
  stdout = "";
  expect(
    await runAppRequest(
      { json: true, noInput: true, resume: setupId },
      dependencies,
    ),
  ).toBe(3);
  expect(store().get("dcr_saved")?.approvedScopes).toEqual([
    "github.repositories",
  ]);
  expect(bodies).toHaveLength(2);
});

it("does not send consent creation if its local intent cannot be persisted", async () => {
  fs.mkdirSync(path.join(home, "requests.json"));
  expect(
    await runAppRequest(
      { json: true, noInput: true, scopes: "github.repositories" },
      deps(),
    ),
  ).toBe(1);
  expect(bodies).toEqual([]);
  expect(appOutcomeSchema.parse(JSON.parse(stdout)).code).toBe("internal");
});
