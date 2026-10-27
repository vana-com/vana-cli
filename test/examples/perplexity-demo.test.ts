import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import {
  GENERIC_PAYMENT_TYPES,
  genericPaymentDomain,
} from "@opendatalabs/vana-sdk/protocol/escrow";

// Public Hardhat identity, never an app or owner credential.
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const APP = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OWNER = "0x1111111111111111111111111111111111111111";
const GRANT = `0x${"1".repeat(64)}`;
const BUILDER = `0x${"2".repeat(64)}`;
const SERVER = "https://personal-server.example";
const SCOPE = "perplexity.conversations";
const REQUEST = "dcr_perplexity";
const mockFetch = vi.fn();
let directory: string;
let grant: Record<string, unknown>;
let challenge: Record<string, unknown>;
let payload: unknown;
let readFailure = false;
let ackFailure = false;
let available = "1000000000000000000";
let paidHeaders: string[];
let acknowledgements: number;
let accessStatus: string;
let accessNetwork: string;
let omitCompletedBinding: boolean;
let serverStatus: number;
let failConnectionSave = false;
let connectionBackup: { file: string; body: string } | undefined;

function request(
  route: string,
  body?: unknown,
  cookie?: string,
  origin = "http://localhost:3090",
) {
  return new Request(`http://localhost:3090/api/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(path.join(os.tmpdir(), "shelf-test-"));
  for (const [key, value] of Object.entries({
    VANA_PRIVATE_KEY: PRIVATE_KEY,
    VANA_APP_ADDRESS: APP,
    APP_URL: "http://localhost:3090",
    VANA_ENV: "prod",
    VANA_SHELF_DIRECTORY: directory,
    VANA_ALLOW_MOKSHA_PAYMENT: "true",
    VANA_MAX_FEE: "0.02",
    VANA_MAX_TOTAL: "0.04",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("VANA_RESUME_REQUEST_ID", undefined);
  vi.stubEnv("VANA_APPROVAL_URL", undefined);
  grant = {
    id: GRANT,
    grantorAddress: OWNER,
    granteeId: BUILDER,
    scopes: [SCOPE],
    status: "pending",
    grantVersion: "1",
    expiresAt: null,
    expired: false,
    revokedAt: null,
    fee: { asset: zeroAddress, totalDue: "11000000000000000" },
  };
  challenge = {
    grantId: GRANT,
    opId: GRANT,
    opType: "grant",
    network: "vana:14800",
    asset: zeroAddress,
    amount: "11000000000000000",
    paymentNonce: "44",
  };
  payload = {
    scope: SCOPE,
    data: {
      conversations: [
        {
          id: "thread-1",
          title: "A real integration fixture",
          update_time: "2026-10-27T01:00:00.000000Z",
        },
      ],
    },
  };
  readFailure = false;
  ackFailure = false;
  available = "1000000000000000000";
  paidHeaders = [];
  acknowledgements = 0;
  accessStatus = "approved";
  accessNetwork = "moksha";
  omitCompletedBinding = false;
  serverStatus = 200;
  failConnectionSave = false;
  connectionBackup = undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith("/consumer-ack")) {
        acknowledgements++;
        if (!ackFailure) accessStatus = "completed";
        return Response.json({}, { status: ackFailure ? 503 : 200 });
      }
      if (url.endsWith("/api/data-connection-requests"))
        return Response.json({
          requestId: REQUEST,
          approvalUrl: `https://app.vana.org/data-connection-requests/${REQUEST}?mode=page`,
          appAddress: APP,
          network: "moksha",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      if (url.endsWith(`/api/data-connection-requests/${REQUEST}`))
        return Response.json(
          omitCompletedBinding && accessStatus === "completed"
            ? { status: "completed" }
            : {
                status: accessStatus,
                network: accessNetwork,
                delivery: "personal_server",
                personalServerUrl: SERVER,
                grantId: GRANT,
                scopes: [SCOPE],
              },
        );
      if (url === `${SERVER}/v1/data/${SCOPE}`) {
        if (serverStatus !== 200)
          return Response.json(
            { error: "not_ready" },
            { status: serverStatus },
          );
        if (!init?.headers?.["X-PAYMENT"])
          return Response.json(challenge, { status: 402 });
        paidHeaders.push(init.headers["X-PAYMENT"]);
        if (readFailure) throw new Error("connection reset after payment");
        if (failConnectionSave) {
          const file = path.join(
            directory,
            (await readdir(directory)).find((name) => name.endsWith(".json"))!,
          );
          connectionBackup = { file, body: await readFile(file, "utf8") };
          await rm(file);
          await mkdir(file);
          failConnectionSave = false;
        }
        return Response.json(payload);
      }
      // Gateway wire fixtures, interpreted by the real SDK.
      if (url.includes(`/v1/grants/${GRANT}`))
        return Response.json({ data: grant, proof: {} });
      if (url.includes(`/v1/builders/${APP}`))
        return Response.json({
          data: { id: BUILDER, granteeAddress: APP },
          proof: {},
        });
      if (url.includes(`/v1/servers?owner=${OWNER}`))
        return Response.json({
          active: [{ ownerAddress: OWNER, serverUrl: SERVER }],
          revoked: [],
          count: 1,
        });
      if (url.includes("/v1/escrow/balance"))
        return Response.json({
          account: APP,
          balances: [{ asset: zeroAddress, availableAmount: available }],
        });
      throw new Error(`Unexpected transport ${url}`);
    },
  );
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function connect() {
  const { POST } =
    await import("../../examples/perplexity-demo/src/app/api/connect/route.js");
  const response = await POST(request("connect", {}));
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function read(cookie: string) {
  const { POST } =
    await import("../../examples/perplexity-demo/src/app/api/data/route.js");
  return POST(request("data", { requestId: REQUEST }, cookie));
}

describe("Perplexity demo delivery through its HTTP routes", () => {
  it("creates a signed Moksha request and does not expose the app key", async () => {
    const cookie = await connect();
    expect(cookie).toMatch(/^research_shelf=[a-f0-9]{64}$/);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      appAddress: APP,
      network: "moksha",
      scopes: [SCOPE],
      source: "perplexity",
    });
    expect(init.headers["X-Vana-App-Signature"]).toMatch(/^0x/);
    expect(JSON.stringify(init)).not.toContain(PRIVATE_KEY);
  });

  it.each([
    ["VANA_APP_ADDRESS", "0x1111111111111111111111111111111111111111"],
    ["VANA_PRIVATE_KEY", "invalid"],
    ["VANA_ENV", "staging"],
    ["APP_URL", "javascript:alert(1)"],
    ["APP_URL", "https://user:password@example.test"],
    ["VANA_MAX_FEE", "-0.1"],
    ["VANA_MAX_TOTAL", "0.0000000000000000001"],
  ])("fails closed on invalid %s configuration", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(
      import("../../examples/perplexity-demo/src/config.js"),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses dev Vana hosts with Moksha fixed independently of VANA_NETWORK", async () => {
    vi.stubEnv("VANA_ENV", "dev");
    vi.stubEnv("VANA_NETWORK", "mainnet");
    await connect();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://app-dev.vana.org/api/data-connection-requests");
    expect(JSON.parse(init.body)).toMatchObject({
      network: "moksha",
      scopes: [SCOPE],
    });
  });

  it.each(["denied", "expired"])(
    "does not read or pay for a %s access request",
    async (status) => {
      const cookie = await connect();
      accessStatus = status;
      const response = await read(cookie);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "approval_required",
      });
      expect(paidHeaders).toHaveLength(0);
      expect(acknowledgements).toBe(0);
    },
  );

  it("rejects a request explicitly reporting the wrong network", async () => {
    const cookie = await connect();
    accessNetwork = "mainnet";
    expect((await read(cookie)).status).toBe(403);
    expect(paidHeaders).toHaveLength(0);
  });

  it("signs a capped testnet payment, saves before acknowledgement, and recovers saved data after restart", async () => {
    const cookie = await connect();
    const response = await read(cookie);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.data.threads).toEqual([
      {
        id: "thread-1",
        title: "A real integration fixture",
        updatedAt: "2026-10-27T01:00:00.000000Z",
      },
    ]);
    expect(acknowledgements).toBe(0);
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    expect((await stat(path.join(directory, files[0]))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      JSON.parse(await readFile(path.join(directory, files[0]), "utf8")).saved
        .revision,
    ).toBe(result.data.revision);
    const signed = JSON.parse(Buffer.from(paidHeaders[0], "base64").toString());
    expect(signed).toMatchObject({
      network: "vana:14800",
      payload: {
        message: {
          payerAddress: APP,
          opType: "grant",
          opId: GRANT,
          asset: zeroAddress,
          amount: "11000000000000000",
          paymentNonce: "44",
        },
      },
    });
    const signer = await recoverTypedDataAddress({
      domain: genericPaymentDomain(
        14800,
        (await import("@opendatalabs/vana-sdk")).CONTRACTS.DataPortabilityEscrow
          .addresses[14800],
      ),
      types: GENERIC_PAYMENT_TYPES,
      primaryType: "GenericPayment",
      message: {
        ...signed.payload.message,
        amount: BigInt(signed.payload.message.amount),
        paymentNonce: BigInt(signed.payload.message.paymentNonce),
      },
      signature: signed.payload.signature,
    });
    expect(signer).toBe(APP);
    vi.resetModules();
    const { GET } =
      await import("../../examples/perplexity-demo/src/app/api/data/route.js");
    expect(
      await (await GET(request("data", undefined, cookie))).json(),
    ).toMatchObject({ saved: result.data, acknowledged: false });
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/acknowledge/route.js");
    expect(
      (
        await POST(
          request("acknowledge", { revision: result.data.revision }, cookie),
        )
      ).status,
    ).toBe(200);
    expect(acknowledgements).toBe(1);
    expect(
      (
        await POST(
          request("acknowledge", { revision: result.data.revision }, cookie),
        )
      ).status,
    ).toBe(200);
    expect(acknowledgements).toBe(1);
    expect((await read(cookie)).status).toBe(200);
    expect(paidHeaders).toHaveLength(1);
  });

  it.each([
    [
      "opt-in absent",
      () => vi.stubEnv("VANA_ALLOW_MOKSHA_PAYMENT", "false"),
      "payment_disabled",
    ],
    [
      "cap absent",
      () => vi.stubEnv("VANA_MAX_FEE", undefined),
      "payment_disabled",
    ],
    [
      "fee exceeds cap",
      () => vi.stubEnv("VANA_MAX_FEE", "0.001"),
      "fee_cap_exceeded",
    ],
    [
      "mainnet challenge",
      () => {
        challenge.network = "vana:1480";
      },
      "payment_invalid",
    ],
    [
      "different asset",
      () => {
        challenge.asset = OWNER;
      },
      "payment_invalid",
    ],
    [
      "unfunded app",
      () => {
        available = "0";
      },
      "funding_required",
    ],
  ] as const)(
    "refuses %s without a payment or acknowledgement",
    async (_label, change, code) => {
      change();
      const cookie = await connect();
      const response = await read(cookie);
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ code });
      expect(paidHeaders).toHaveLength(0);
      expect(acknowledgements).toBe(0);
    },
  );

  it.each(["revoked", "expired", "foreign", "wrong scope"])(
    "refuses a %s grant before reading",
    async (kind) => {
      if (kind === "revoked") grant.revokedAt = "2026-10-27T00:00:00Z";
      if (kind === "expired") grant.expired = true;
      if (kind === "foreign") grant.granteeId = GRANT;
      if (kind === "wrong scope") grant.scopes = ["chatgpt.conversations"];
      const cookie = await connect();
      expect((await read(cookie)).status).toBe(403);
      expect(mockFetch.mock.calls.some(([url]) => url.startsWith(SERVER))).toBe(
        false,
      );
    },
  );

  it("retains an uncertain signed payment and replays it instead of authorizing a second fee", async () => {
    const cookie = await connect();
    readFailure = true;
    expect((await read(cookie)).status).toBe(502);
    expect(acknowledgements).toBe(0);
    const first = paidHeaders[0];
    vi.resetModules();
    readFailure = false;
    expect((await read(cookie)).status).toBe(200);
    expect(paidHeaders).toEqual([first, first]);
    const state = JSON.parse(
      await readFile(
        path.join(
          directory,
          "payments",
          (await readdir(path.join(directory, "payments")))[0],
        ),
        "utf8",
      ),
    );
    expect(state.spent).toBe("11000000000000000");
  });

  it("keeps the payment receipt and total spending across reconnecting browsers", async () => {
    const firstBrowser = await connect();
    readFailure = true;
    expect((await read(firstBrowser)).status).toBe(502);
    const receipt = paidHeaders[0];
    vi.resetModules();
    const secondBrowser = await connect();
    readFailure = false;
    expect((await read(secondBrowser)).status).toBe(200);
    expect(paidHeaders).toEqual([receipt, receipt]);
    const ledgers = await readdir(path.join(directory, "payments"));
    expect(ledgers).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(path.join(directory, "payments", ledgers[0]), "utf8"),
      ).spent,
    ).toBe("11000000000000000");
  });

  it("does not transmit an uncertain payment after payment opt-in is withdrawn", async () => {
    const cookie = await connect();
    readFailure = true;
    expect((await read(cookie)).status).toBe(502);
    vi.resetModules();
    vi.stubEnv("VANA_ALLOW_MOKSHA_PAYMENT", "false");
    readFailure = false;
    const response = await read(cookie);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "payment_disabled" });
    expect(paidHeaders).toHaveLength(1);
  });

  it("retains a malformed delivered body without acknowledging or silently paying for a replacement", async () => {
    const cookie = await connect();
    payload = {
      scope: SCOPE,
      data: { conversations: [{ id: "x", title: 123, update_time: null }] },
    };
    expect((await read(cookie)).status).toBe(502);
    expect(acknowledgements).toBe(0);
    const ledgerFile = (await readdir(path.join(directory, "payments")))[0];
    const ledger = JSON.parse(
      await readFile(path.join(directory, "payments", ledgerFile), "utf8"),
    );
    expect(ledger.received.body).toEqual(payload);
    const calls = mockFetch.mock.calls.filter(([url]) =>
      url.startsWith(SERVER),
    ).length;
    expect((await read(cookie)).status).toBe(502);
    expect(
      mockFetch.mock.calls.filter(([url]) => url.startsWith(SERVER)),
    ).toHaveLength(calls);
  });

  it("accepts a valid empty result and retries confirmation without another read or payment", async () => {
    const cookie = await connect();
    payload = { scope: SCOPE, data: { conversations: [] } };
    const result = await (await read(cookie)).json();
    expect(result.data.threads).toEqual([]);
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/acknowledge/route.js");
    ackFailure = true;
    expect(
      (
        await POST(
          request("acknowledge", { revision: result.data.revision }, cookie),
        )
      ).status,
    ).toBe(502);
    ackFailure = false;
    expect(
      (
        await POST(
          request("acknowledge", { revision: result.data.revision }, cookie),
        )
      ).status,
    ).toBe(200);
    expect(paidHeaders).toHaveLength(1);
  });

  async function delivered() {
    const cookie = await connect();
    const result = await (await read(cookie)).json();
    const ack =
      await import("../../examples/perplexity-demo/src/app/api/acknowledge/route.js");
    expect(
      (
        await ack.POST(
          request("acknowledge", { revision: result.data.revision }, cookie),
        )
      ).status,
    ).toBe(200);
    return { cookie, initial: result.data };
  }

  it("reads changed output through the retained grant after the original request completes", async () => {
    const { cookie, initial } = await delivered();
    omitCompletedBinding = true;
    challenge.paymentNonce = "45";
    payload = {
      scope: SCOPE,
      data: {
        conversations: [
          {
            id: "thread-1",
            title: "CLI edit — A real integration fixture",
            update_time: "2026-10-27T01:00:00.000000Z",
          },
        ],
      },
    };
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    const response = await POST(request("latest", {}, cookie));
    const latest = await response.json();
    expect(response.status).toBe(200);
    expect(latest.data.revision).not.toBe(initial.revision);
    expect(latest.data.threads[0]).toMatchObject({
      id: "thread-1",
      title: "CLI edit — A real integration fixture",
    });
    expect(paidHeaders).toHaveLength(2);
    expect(paidHeaders[0]).not.toBe(paidHeaders[1]);
    const reads = mockFetch.mock.calls.filter(([url]) =>
      url.startsWith(SERVER),
    );
    expect(reads).toHaveLength(4);
    expect(acknowledgements).toBe(1);
    const { GET } =
      await import("../../examples/perplexity-demo/src/app/api/data/route.js");
    expect(
      await (await GET(request("data", undefined, cookie))).json(),
    ).toMatchObject({ saved: latest.data, acknowledged: false });
    const ledger = JSON.parse(
      await readFile(
        path.join(
          directory,
          "payments",
          (await readdir(path.join(directory, "payments")))[0],
        ),
        "utf8",
      ),
    );
    expect(ledger.spent).toBe("22000000000000000");
    expect(ledger.history).toHaveLength(1);
    // Every real SDK read keeps the same grant in its signed authorization.
    for (const [, init] of reads) {
      const encoded = init.headers.Authorization.slice(
        "Web3Signed ".length,
      ).split(".")[0];
      expect(
        JSON.parse(Buffer.from(encoded, "base64url").toString()),
      ).toMatchObject({
        grantId: GRANT,
        aud: SERVER,
        uri: `/v1/data/${SCOPE}`,
      });
    }
    expect(
      mockFetch.mock.calls.filter(([url]) =>
        url.endsWith("/api/data-connection-requests"),
      ),
    ).toHaveLength(1);
  });

  it("replays an uncertain latest-read payment instead of replacing it with a third fee", async () => {
    const { cookie } = await delivered();
    challenge.paymentNonce = "45";
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    readFailure = true;
    expect((await POST(request("latest", {}, cookie))).status).toBe(502);
    const second = paidHeaders[1];
    readFailure = false;
    expect((await POST(request("latest", {}, cookie))).status).toBe(200);
    expect(paidHeaders).toEqual([paidHeaders[0], second, second]);
    const ledger = JSON.parse(
      await readFile(
        path.join(
          directory,
          "payments",
          (await readdir(path.join(directory, "payments")))[0],
        ),
        "utf8",
      ),
    );
    expect(ledger.spent).toBe("22000000000000000");
    expect(ledger.history).toHaveLength(1);
  });

  it("recovers a latest delivered body after decoding fails without paying for another replacement", async () => {
    const { cookie } = await delivered();
    challenge.paymentNonce = "45";
    payload = {
      scope: SCOPE,
      data: {
        conversations: [{ id: "thread-1", title: 123, update_time: null }],
      },
    };
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    expect((await POST(request("latest", {}, cookie))).status).toBe(502);
    expect(paidHeaders).toHaveLength(2);
    expect((await POST(request("latest", {}, cookie))).status).toBe(502);
    expect(paidHeaders).toHaveLength(2);
    expect(acknowledgements).toBe(1);
  });

  it("recovers the received latest body after a real connection-file save failure without another read", async () => {
    const { cookie } = await delivered();
    challenge.paymentNonce = "45";
    failConnectionSave = true;
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    expect((await POST(request("latest", {}, cookie))).status).toBe(502);
    expect(paidHeaders).toHaveLength(2);
    if (!connectionBackup)
      throw new Error("Expected a file-system save failure");
    await rm(connectionBackup.file, { recursive: true });
    await writeFile(connectionBackup.file, connectionBackup.body);
    const calls = mockFetch.mock.calls.filter(([url]) =>
      url.startsWith(SERVER),
    ).length;
    expect((await POST(request("latest", {}, cookie))).status).toBe(200);
    expect(
      mockFetch.mock.calls.filter(([url]) => url.startsWith(SERVER)),
    ).toHaveLength(calls);
    expect(paidHeaders).toHaveLength(2);
  });

  it("recovers a lost successful latest response before requiring its acknowledgement", async () => {
    const { cookie } = await delivered();
    challenge.paymentNonce = "45";
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    const ignored = await (await POST(request("latest", {}, cookie))).json();
    const recovered = await (await POST(request("latest", {}, cookie))).json();
    expect(recovered).toEqual(ignored);
    expect(paidHeaders).toHaveLength(2);
    expect(acknowledgements).toBe(1);
  });

  it("adopts an acknowledged BUI-931 ledger using the matching saved body, retaining its receipt and cost", async () => {
    const { cookie } = await delivered();
    challenge.paymentNonce = "45";
    const file = path.join(
      directory,
      "payments",
      (await readdir(path.join(directory, "payments")))[0],
    );
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.format;
    delete legacy.received.paymentHeaderHash;
    await writeFile(file, JSON.stringify(legacy));
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    expect((await POST(request("latest", {}, cookie))).status).toBe(200);
    const adopted = JSON.parse(await readFile(file, "utf8"));
    expect(adopted.format).toBe(2);
    expect(adopted.history[0].header).toBe(legacy.payment.header);
    expect(adopted.spent).toBe("22000000000000000");
  });

  it.each([
    "revoked",
    "expired",
    "scope",
    "owner",
    "server unavailable",
    "syncing",
  ])("keeps saved threads when a latest read is refused: %s", async (kind) => {
    const { cookie, initial } = await delivered();
    if (kind === "revoked") grant.revokedAt = "2026-10-27T00:00:00Z";
    if (kind === "expired") grant.expired = true;
    if (kind === "scope") grant.scopes = ["chatgpt.conversations"];
    if (kind === "owner")
      grant.grantorAddress = "0x3333333333333333333333333333333333333333";
    if (kind === "server unavailable") serverStatus = 503;
    if (kind === "syncing") serverStatus = 409;
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    expect((await POST(request("latest", {}, cookie))).ok).toBe(false);
    expect(paidHeaders).toHaveLength(1);
    const { GET } =
      await import("../../examples/perplexity-demo/src/app/api/data/route.js");
    expect(
      await (await GET(request("data", undefined, cookie))).json(),
    ).toMatchObject({ saved: initial, acknowledged: true });
  });

  it("requires completed initial delivery and refuses browser-selected grant/server/scope overrides", async () => {
    const cookie = await connect();
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/latest/route.js");
    expect((await POST(request("latest", {}, cookie))).status).toBe(409);
    expect(
      (
        await POST(
          request(
            "latest",
            { grantId: GRANT, personalServerUrl: SERVER, scope: SCOPE },
            cookie,
          ),
        )
      ).status,
    ).toBe(400);
    expect(paidHeaders).toHaveLength(0);
  });

  it("rejects cross-site actions, unknown browsers, injected grant/server fields, and unsaved acknowledgement", async () => {
    const connectRoute =
      await import("../../examples/perplexity-demo/src/app/api/connect/route.js");
    expect(
      (
        await connectRoute.POST(
          request("connect", {}, undefined, "https://attacker.example"),
        )
      ).status,
    ).toBe(403);
    const cookie = await connect();
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/data/route.js");
    expect((await POST(request("data", { requestId: REQUEST }))).status).toBe(
      401,
    );
    expect(
      (
        await POST(
          request(
            "data",
            { requestId: REQUEST, serverUrl: "http://attacker" },
            cookie,
          ),
        )
      ).status,
    ).toBe(400);
    const ack =
      await import("../../examples/perplexity-demo/src/app/api/acknowledge/route.js");
    expect(
      (await ack.POST(request("acknowledge", { revision: "unsaved" }, cookie)))
        .status,
    ).toBe(409);
    expect(acknowledgements).toBe(0);
    expect(paidHeaders).toHaveLength(0);
  });
});
