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
