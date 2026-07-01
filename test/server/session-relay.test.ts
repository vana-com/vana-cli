import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionRelay } from "../../src/server/session-relay.js";
import { ConnectError, ConnectErrorCode } from "../../src/core/errors.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_GRANTEE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const RELAY_URL = "https://session-relay.example.com";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSessionRelay", () => {
  describe("initSession", () => {
    it("sends POST to /v1/session/init with Web3Signed auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "sess-123",
          deepLinkUrl: "vana://connect?sessionId=sess-123&secret=abc",
          expiresAt: "2026-02-09T12:00:00Z",
        }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const result = await relay.initSession({
        scopes: ["instagram.profile"],
      });

      expect(result.sessionId).toBe("sess-123");
      expect(result.deepLinkUrl).toContain("secret=");

      expect(mockFetch).toHaveBeenCalledWith(
        `${RELAY_URL}/v1/session/init`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: expect.stringMatching(/^Web3Signed /),
          }),
        }),
      );

      // Verify body contains granteeAddress and scopes
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.granteeAddress).toBe(TEST_GRANTEE);
      expect(callBody.scopes).toEqual(["instagram.profile"]);

      const authHeader = mockFetch.mock.calls[0][1].headers
        .Authorization as string;
      const payloadBase64 = authHeader.replace("Web3Signed ", "").split(".")[0];
      const payload = JSON.parse(
        Buffer.from(payloadBase64, "base64").toString("utf-8"),
      );
      expect(payload.bodyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.bodyHash).not.toMatch(/^sha256:/);
    });

    it("includes optional webhookUrl and appUserId in body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "sess-456",
          deepLinkUrl: "vana://connect?sessionId=sess-456&secret=def",
          expiresAt: "2026-02-09T12:00:00Z",
        }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      await relay.initSession({
        scopes: ["test.scope"],
        webhookUrl: "https://webhook.example.com",
        appUserId: "user-42",
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.webhookUrl).toBe("https://webhook.example.com");
      expect(callBody.appUserId).toBe("user-42");
    });

    it("maps SDK init errors to ConnectError", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            errorCode: "BUILDER_NOT_REGISTERED",
            message: "Builder not registered",
          },
        }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const promise = relay.initSession({ scopes: ["test"] });

      await expect(promise).rejects.toThrow(ConnectError);
      await expect(promise).rejects.toMatchObject({
        code: "BUILDER_NOT_REGISTERED",
        message: "Builder not registered",
        statusCode: 403,
      });
    });
  });

  describe("pollSession", () => {
    it("sends GET to /v1/session/{id}/poll without auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending" }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const result = await relay.pollSession("sess-123");

      expect(result.status).toBe("pending");
      expect(mockFetch).toHaveBeenCalledWith(
        `${RELAY_URL}/v1/session/sess-123/poll`,
        { method: "GET" },
      );
    });

    it("returns grant when approved", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "approved",
          grant: {
            grantId: "grant-1",
            userAddress: "0xuser",
            builderAddress: TEST_GRANTEE,
            scopes: ["instagram.profile"],
          },
        }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const result = await relay.pollSession("sess-123");
      expect(result.status).toBe("approved");
      expect(result.grant?.grantId).toBe("grant-1");
    });

    it("maps SDK poll errors to ConnectError", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            errorCode: "SESSION_NOT_FOUND",
            message: "Session not found",
          },
        }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const promise = relay.pollSession("nonexistent");

      await expect(promise).rejects.toThrow(ConnectError);
      await expect(promise).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
        message: "Session not found",
        statusCode: 404,
      });
    });
  });

  describe("pollUntilComplete", () => {
    it("resolves when status is approved", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: "pending" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "approved",
            grant: {
              grantId: "grant-1",
              userAddress: "0xuser",
              builderAddress: TEST_GRANTEE,
              scopes: ["test"],
            },
          }),
        });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const result = await relay.pollUntilComplete("sess-123", {
        interval: 10,
        timeout: 5000,
      });

      expect(result.status).toBe("approved");
    });

    it("resolves when status is denied", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "denied", reason: "User declined" }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const result = await relay.pollUntilComplete("sess-123", {
        interval: 10,
        timeout: 5000,
      });

      expect(result.status).toBe("denied");
      expect(result.reason).toBe("User declined");
    });

    it("throws on timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "pending" }),
      });

      const relay = createSessionRelay({
        privateKey: TEST_PRIVATE_KEY,
        granteeAddress: TEST_GRANTEE,
        sessionRelayUrl: RELAY_URL,
      });

      const promise = relay.pollUntilComplete("sess-123", {
        interval: 10,
        timeout: 50,
      });
      await expect(promise).rejects.toThrow("Polling timed out");
      await expect(promise).rejects.toMatchObject({
        code: ConnectErrorCode.POLL_TIMEOUT,
      });
    });
  });
});
