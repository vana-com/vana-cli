import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPersonalServerClient } from "../../src/personal-server/client.js";

const SERVER_URL = "https://personal-server.example.com";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPersonalServerClient", () => {
  describe("health", () => {
    it("returns parsed health on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "ok",
          version: "0.1.0",
          uptime: 12345,
          owner: "0xabc",
        }),
      });

      const client = createPersonalServerClient({ url: SERVER_URL });
      const health = await client.health();

      expect(health).toEqual({
        status: "ok",
        version: "0.1.0",
        uptime: 12345,
        owner: "0xabc",
      });
      expect(mockFetch).toHaveBeenCalledWith(`${SERVER_URL}/health`, {
        method: "GET",
        signal: expect.any(AbortSignal),
      });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const client = createPersonalServerClient({ url: SERVER_URL });
      await expect(client.health()).rejects.toThrow("Health check failed: 503");
    });
  });

  describe("ingestScope", () => {
    it("returns stored result on 201", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ collectedAt: "2026-01-01T00:00:00Z" }),
      });

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });
      const result = await client.ingestScope("github.profile", {
        login: "alice",
      });

      expect(result.scope).toBe("github.profile");
      expect(result.status).toBe("stored");
      expect(result.collectedAt).toBe("2026-01-01T00:00:00Z");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${SERVER_URL}/v1/data/github.profile`);
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe("Bearer test-token");
    });

    it("returns failed result on non-2xx", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const client = createPersonalServerClient({ url: SERVER_URL });
      const result = await client.ingestScope("github.profile", {
        login: "alice",
      });

      expect(result.scope).toBe("github.profile");
      expect(result.status).toBe("failed");
      expect(result.error).toContain("500");
    });
  });

  describe("listScopes", () => {
    it("returns scopes on success with auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          scopes: [
            { scope: "github.profile", count: 3 },
            { scope: "github.repos", count: 12 },
          ],
        }),
      });

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });
      const scopes = await client.listScopes("github");

      expect(scopes).toEqual([
        { scope: "github.profile", count: 3 },
        { scope: "github.repos", count: 12 },
      ]);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${SERVER_URL}/v1/data?limit=100&offset=0&scopePrefix=github`,
      );
      expect(opts.headers.Authorization).toBe("Bearer test-token");
    });

    it("reads every page when the server has more scopes than one page", async () => {
      const page = (start: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          scope: `source.scope${start + i}`,
          count: 1,
        }));
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ scopes: page(0, 100), total: 130 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ scopes: page(100, 30), total: 130 }),
        });

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });
      const scopes = await client.listScopes();

      expect(scopes).toHaveLength(130);
      expect(scopes.at(-1)?.scope).toBe("source.scope129");
      expect(mockFetch.mock.calls[1][0]).toBe(
        `${SERVER_URL}/v1/data?limit=100&offset=100`,
      );
    });

    it("stops paging when a server keeps reporting more than it returns", async () => {
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          scopes: [{ scope: "same.scope", count: 1 }],
          total: 1_000_000,
        }),
      }));

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });
      await client.listScopes();

      expect(mockFetch).toHaveBeenCalledTimes(100);
      mockFetch.mockReset();
    });

    it("normalizes versionCount responses from the personal server", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          scopes: [
            { scope: "github.profile", versionCount: 3 },
            { scope: "github.repos", versionCount: 12 },
          ],
        }),
      });

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });
      const scopes = await client.listScopes("github");

      expect(scopes).toEqual([
        { scope: "github.profile", count: 3 },
        { scope: "github.repos", count: 12 },
      ]);
    });

    it("returns empty array when no auth configured", async () => {
      const client = createPersonalServerClient({ url: SERVER_URL });
      const scopes = await client.listScopes();

      expect(scopes).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns empty array when auth type is none", async () => {
      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "none" },
      });
      const scopes = await client.listScopes();

      expect(scopes).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when the remote personal server query fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      });

      const client = createPersonalServerClient({
        url: SERVER_URL,
        auth: { type: "bearerToken", token: "test-token" },
      });

      await expect(client.listScopes()).rejects.toThrow(
        "Scope listing failed: HTTP 503: Service Unavailable",
      );
    });
  });
});
