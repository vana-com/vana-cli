import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHex, recoverMessageAddress } from "viem";

// Public Hardhat fixture identity. Never a real app or owner credential.
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const APP_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VANA_PRIVATE_KEY", PRIVATE_KEY);
  vi.stubEnv("VANA_APP_ADDRESS", APP_ADDRESS);
  vi.stubEnv("APP_URL", "http://localhost:3090");
  vi.stubEnv("VANA_ENV", "prod");
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Perplexity demo request boundary", () => {
  it.each([
    ["prod", "https://app.vana.org"],
    ["dev", "https://app-dev.vana.org"],
  ])(
    "signs conversations-only Moksha requests on %s hosts",
    async (env, origin) => {
      vi.stubEnv("VANA_ENV", env);
      vi.stubEnv("VANA_NETWORK", "mainnet");
      mockFetch.mockResolvedValue(
        Response.json({
          requestId: "dcr_perplexity",
          appAddress: APP_ADDRESS,
          network: "moksha",
          approvalUrl: `${origin}/data-connection-requests/dcr_perplexity?mode=page`,
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      );
      const { POST } =
        await import("../../examples/perplexity-demo/src/app/api/connect/route.js");
      const response = await POST();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const responseBody = await response.json();
      expect(responseBody).toMatchObject({
        requestId: "dcr_perplexity",
        network: "moksha",
        appAddress: APP_ADDRESS,
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${origin}/api/data-connection-requests`);
      expect(JSON.parse(init.body)).toMatchObject({
        appAddress: APP_ADDRESS,
        app: { id: "perplexity-demo", name: "Research Shelf" },
        source: "perplexity",
        scopes: ["perplexity.conversations"],
        network: "moksha",
        returnUrl: "http://localhost:3090",
      });
      const signature = init.headers["X-Vana-App-Signature"];
      if (!isHex(signature)) throw new Error("Missing signed request");
      const signer = await recoverMessageAddress({
        message: [
          "Vana Direct Access Request v1",
          "method:POST",
          "path:/api/data-connection-requests",
          `timestamp:${init.headers["X-Vana-App-Timestamp"]}`,
          `body:${init.body}`,
        ].join("\n"),
        signature,
      });
      expect(signer).toBe(APP_ADDRESS);
      expect(JSON.stringify(responseBody)).not.toContain(PRIVATE_KEY);
    },
  );

  it("defaults to production hosts while keeping Moksha explicit", async () => {
    vi.stubEnv("VANA_ENV", undefined);
    mockFetch.mockResolvedValue(Response.json({ requestId: "dcr_perplexity" }));
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/connect/route.js");
    await POST();
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://app.vana.org/api/data-connection-requests",
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).network).toBe("moksha");
  });

  it.each([
    ["VANA_APP_ADDRESS", "0x1111111111111111111111111111111111111111"],
    ["VANA_PRIVATE_KEY", "invalid"],
    ["VANA_ENV", "staging"],
    ["APP_URL", "javascript:alert(1)"],
    ["APP_URL", "https://user:password@example.test"],
  ])("fails closed on invalid %s configuration", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(
      import("../../examples/perplexity-demo/src/config.js"),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns a failure when request creation cannot reach Vana", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/connect/route.js");
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty("error");
  });
});

describe("Perplexity demo status and read boundary", () => {
  it.each(["pending", "denied", "expired", "ready_for_read", "completed"])(
    "polls signed, uncached %s status",
    async (status) => {
      mockFetch.mockResolvedValue(Response.json({ status }));
      const { GET } =
        await import("../../examples/perplexity-demo/src/app/api/status/route.js");
      const response = await GET(
        new Request(
          "http://localhost:3090/api/status?requestId=dcr_perplexity",
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ status });
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://app.vana.org/api/data-connection-requests/dcr_perplexity",
      );
      expect(mockFetch.mock.calls[0][1].headers["X-Vana-App-Address"]).toBe(
        APP_ADDRESS,
      );
    },
  );
  it.each(["", "?requestId=../other", "?requestId=dcr_one&requestId=dcr_two"])(
    "rejects malformed status input: %s",
    async (query) => {
      const { GET } =
        await import("../../examples/perplexity-demo/src/app/api/status/route.js");
      expect(
        (await GET(new Request(`http://localhost:3090/api/status${query}`)))
          .status,
      ).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );
  it("refuses data reads without a grant read, payment, settlement or acknowledgment", async () => {
    const { POST } =
      await import("../../examples/perplexity-demo/src/app/api/data/route.js");
    const response = await POST();
    expect(response.status).toBe(501);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "read_not_enabled" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
