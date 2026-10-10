import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const APP_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const APPROVAL_URL =
  "https://app-dev.vana.org/data-connection-requests/dcr_starter?mode=page";
const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VANA_PRIVATE_KEY", PRIVATE_KEY);
  vi.stubEnv("VANA_APP_PRIVATE_KEY", PRIVATE_KEY);
  vi.stubEnv("APP_URL", "http://localhost:3001");
  vi.stubEnv("VANA_ENV", "dev");
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Next.js starter handoff", () => {
  it("creates a signed Direct request with an approval URL usable by current Vana", async () => {
    mockFetch.mockImplementation(async (input: string) => {
      if (input.endsWith("/v1/session/init")) {
        return Response.json({
          sessionId: "sess_starter",
          deepLinkUrl: "vana://connect?sessionId=sess_starter&secret=fixture",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      if (input.endsWith("/api/data-connection-requests")) {
        return Response.json({
          requestId: "dcr_starter",
          approvalUrl: APPROVAL_URL,
          appAddress: APP_ADDRESS,
          network: "moksha",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      throw new Error(`Unexpected transport: ${input}`);
    });

    const { POST } =
      await import("../../examples/nextjs-starter/src/app/api/connect/route.js");
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: "dcr_starter",
      approvalUrl: APPROVAL_URL,
      appAddress: APP_ADDRESS,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://app-dev.vana.org/api/data-connection-requests");
    expect(options.headers["X-Vana-App-Address"]).toBe(APP_ADDRESS);
    expect(options.headers["X-Vana-App-Signature"]).toMatch(/^0x[0-9a-f]+$/i);
    expect(JSON.parse(options.body)).toMatchObject({
      appAddress: APP_ADDRESS,
      source: "chatgpt",
      scopes: ["chatgpt.conversations"],
      returnUrl: "http://localhost:3001",
    });
  });
});

const STATUS_URL =
  "https://app-dev.vana.org/api/data-connection-requests/dcr_starter";
const DATA_URL =
  "https://personal-server.example/v1/data/chatgpt.conversations";
const approved = {
  status: "approved",
  delivery: "personal_server",
  personalServerUrl: "https://personal-server.example",
  grantId: `0x${"1".repeat(64)}`,
  scopes: ["chatgpt.conversations", "gmail.messages"],
};
const dataRequest = (body: unknown) =>
  new Request("http://localhost:3001/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Next.js starter API boundaries", () => {
  it.each([
    "pending",
    "approved",
    "ready_for_read",
    "completed",
    "denied",
    "expired",
  ])("returns signed, uncached %s status", async (status) => {
    mockFetch.mockResolvedValue(Response.json({ ...approved, status }));
    const { GET } =
      await import("../../examples/nextjs-starter/src/app/api/status/route.js");
    const response = await GET(
      new Request("http://localhost:3001/api/status?requestId=dcr_starter"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(STATUS_URL);
    expect(init.method).toBe("GET");
    expect(init.headers["X-Vana-App-Signature"]).toMatch(/^0x[0-9a-f]+$/i);
  });

  it.each([
    "",
    "?requestId=",
    "?requestId=../other",
    "?requestId=dcr_ok&requestId=dcr_other",
  ])("rejects malformed status input %s before a request", async (query) => {
    const { GET } =
      await import("../../examples/nextjs-starter/src/app/api/status/route.js");
    expect(
      (await GET(new Request(`http://localhost:3001/api/status${query}`)))
        .status,
    ).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(
    [
      null,
      [],
      {},
      { requestId: 7 },
      { requestId: "../other" },
      { requestId: "dcr_starter", grant: approved },
      { requestId: "dcr_starter", scope: "gmail.messages" },
      { requestId: "dcr_starter", personalServerUrl: "https://other.example" },
    ].map((body) => ({ body })),
  )(
    "rejects browser-chosen or malformed read input $body before a request",
    async ({ body }) => {
      const { POST } =
        await import("../../examples/nextjs-starter/src/app/api/data/route.js");
      expect((await POST(dataRequest(body))).status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("returns 400 for malformed JSON", async () => {
    const { POST } =
      await import("../../examples/nextjs-starter/src/app/api/data/route.js");
    const response = await POST(
      new Request("http://localhost:3001/api/data", {
        method: "POST",
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["pending", "denied", "expired", "completed"])(
    "refuses a %s request before contacting a Personal Server",
    async (status) => {
      mockFetch.mockResolvedValue(Response.json({ ...approved, status }));
      const { POST } =
        await import("../../examples/nextjs-starter/src/app/api/data/route.js");
      expect(
        (await POST(dataRequest({ requestId: "dcr_starter" }))).status,
      ).toBe(409);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([STATUS_URL]);
    },
  );

  it("uses the configured scope and acknowledges only after a successful read", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === STATUS_URL) return Response.json(approved);
      if (url === DATA_URL) return Response.json({ conversations: ["Hello"] });
      if (url === `${STATUS_URL}/consumer-ack`)
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected transport: ${url}`);
    });
    const { POST } =
      await import("../../examples/nextjs-starter/src/app/api/data/route.js");
    const response = await POST(dataRequest({ requestId: "dcr_starter" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: "chatgpt.conversations",
      data: { conversations: ["Hello"] },
    });
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      STATUS_URL,
      DATA_URL,
      `${STATUS_URL}/consumer-ack`,
    ]);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toMatch(
      /^Web3Signed /,
    );
    expect(mockFetch.mock.calls[2][1].headers["X-Vana-App-Signature"]).toMatch(
      /^0x[0-9a-f]+$/i,
    );
  });

  it("does not read a different approved scope", async () => {
    mockFetch.mockResolvedValue(
      Response.json({ ...approved, scopes: ["gmail.messages"] }),
    );
    const { POST } =
      await import("../../examples/nextjs-starter/src/app/api/data/route.js");
    expect((await POST(dataRequest({ requestId: "dcr_starter" }))).status).toBe(
      403,
    );
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([STATUS_URL]);
  });

  it("allows an explicit read retry after a transport failure without creating new consent", async () => {
    let reads = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === STATUS_URL) return Response.json(approved);
      if (url === DATA_URL) {
        reads += 1;
        if (reads === 1) throw new Error("connection reset");
        return Response.json({ conversations: [] });
      }
      if (url === `${STATUS_URL}/consumer-ack`)
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected transport: ${url}`);
    });
    const { POST } =
      await import("../../examples/nextjs-starter/src/app/api/data/route.js");
    expect((await POST(dataRequest({ requestId: "dcr_starter" }))).status).toBe(
      500,
    );
    expect(reads).toBe(1);
    expect((await POST(dataRequest({ requestId: "dcr_starter" }))).status).toBe(
      200,
    );
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      STATUS_URL,
      DATA_URL,
      STATUS_URL,
      DATA_URL,
      `${STATUS_URL}/consumer-ack`,
    ]);
  });

  it.each(["create", "status", "data"])(
    "reports %s gateway failures as 500 without exposing upstream details",
    async (route) => {
      mockFetch.mockResolvedValue(
        new Response("private upstream details", { status: 503 }),
      );
      let response: Response;
      if (route === "create") {
        const { POST } =
          await import("../../examples/nextjs-starter/src/app/api/connect/route.js");
        response = await POST();
      } else if (route === "status") {
        const { GET } =
          await import("../../examples/nextjs-starter/src/app/api/status/route.js");
        response = await GET(
          new Request("http://localhost:3001/api/status?requestId=dcr_starter"),
        );
      } else {
        const { POST } =
          await import("../../examples/nextjs-starter/src/app/api/data/route.js");
        response = await POST(dataRequest({ requestId: "dcr_starter" }));
      }
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private upstream details");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["dev", "prod"])(
    "maps %s to the intended SDK Account host",
    async (environment) => {
      vi.stubEnv("VANA_ENV", environment);
      mockFetch.mockResolvedValue(
        Response.json({ requestId: "dcr_starter", appAddress: APP_ADDRESS }),
      );
      const { POST } =
        await import("../../examples/nextjs-starter/src/app/api/connect/route.js");
      expect((await POST()).status).toBe(200);
      expect(mockFetch.mock.calls[0][0]).toBe(
        `https://${environment === "dev" ? "app-dev" : "app"}.vana.org/api/data-connection-requests`,
      );
    },
  );

  it("rejects unknown environments rather than selecting production", async () => {
    vi.stubEnv("VANA_ENV", "staging");
    await expect(
      import("../../examples/nextjs-starter/src/config.js"),
    ).rejects.toThrow('VANA_ENV must be "dev" or "prod"');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

const asset = "0x0000000000000000000000000000000000000000";
const recordId = `0x${"2".repeat(64)}`;
const accessRecord = {
  dataPointId: `0x${"3".repeat(64)}`,
  version: "1",
  accessor: APP_ADDRESS,
  recordId,
  signature: `0x${"4".repeat(130)}`,
};

describe("Next.js starter payment policy", () => {
  it.each([
    ["legacy grant", { grantId: approved.grantId, asset, amount: "1" }],
    [
      "receipt-bound data access",
      {
        x402Version: 1,
        error: "PAYMENT_REQUIRED",
        accepts: [
          {
            scheme: "vana-escrow-grant",
            network: "eip155:14800",
            asset,
            amount: "1",
            message: {
              payerAddress: APP_ADDRESS,
              opId: recordId,
              opType: "data_access",
              asset,
              amount: "1",
              paymentNonce: "5",
            },
            accessRecord,
          },
        ],
      },
    ],
    [
      "receipt-only grant",
      {
        x402Version: 1,
        error: "PAYMENT_REQUIRED",
        accepts: [
          {
            scheme: "vana-escrow-grant",
            network: "eip155:14800",
            asset,
            amount: "0",
            message: {
              payerAddress: APP_ADDRESS,
              opId: approved.grantId,
              opType: "grant",
              asset,
              amount: "0",
              paymentNonce: "5",
            },
            accessRecord,
          },
        ],
      },
    ],
  ])(
    "refuses %s 402 with one Personal Server request and no payment effect",
    async (_name, challenge) => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === STATUS_URL) return Response.json(approved);
        if (url === DATA_URL) return Response.json(challenge, { status: 402 });
        throw new Error(
          `Unexpected payment or acknowledgement transport: ${url}`,
        );
      });
      const { POST } =
        await import("../../examples/nextjs-starter/src/app/api/data/route.js");
      const response = await POST(dataRequest({ requestId: "dcr_starter" }));
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({
        error: "Payment required. This starter does not authorize payments.",
      });
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        STATUS_URL,
        DATA_URL,
      ]);
      for (const [, init] of mockFetch.mock.calls) {
        expect(new Headers(init.headers).has("X-PAYMENT")).toBe(false);
      }
    },
  );
});
