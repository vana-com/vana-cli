import { describe, it, expect } from "vitest";
import { createRequestSigner } from "../../src/server/request-signer.js";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_ADDRESS = privateKeyToAccount(TEST_PRIVATE_KEY).address;
const PREFIXED_EMPTY_BODY_HASH =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("createRequestSigner", () => {
  it("produces a Web3Signed header with correct format", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
    });

    expect(header).toMatch(/^Web3Signed [A-Za-z0-9_-]+\.0x[0-9a-f]+$/);
  });

  it("exposes the correct signer address", () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    expect(signer.address).toBe(TEST_ADDRESS);
  });

  it("produces a signature recoverable to signer address", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "POST",
      uri: "/v1/session/init",
      body: JSON.stringify({ test: true }),
    });

    const parts = header.replace("Web3Signed ", "").split(".");
    // parts[0] = base64url payload, parts[1..] = 0x-prefixed sig (may contain dots in hex)
    const payloadBase64 = parts[0];
    const signature = parts.slice(1).join(".") as `0x${string}`;

    const valid = await verifyMessage({
      address: TEST_ADDRESS,
      message: payloadBase64,
      signature,
    });
    expect(valid).toBe(true);
  });

  it("payload contains sorted keys", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
    });

    const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    const keys = Object.keys(payload);

    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("aud");
    expect(keys).toContain("bodyHash");
    expect(keys).toContain("exp");
    expect(keys).toContain("iat");
    expect(keys).toContain("method");
    expect(keys).toContain("uri");
  });

  it("includes grantId in payload when provided", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
      grantId: "grant-123",
    });

    const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);

    expect(payload.grantId).toBe("grant-123");
  });

  it("omits grantId from payload when not provided", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
    });

    const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);

    expect(payload.grantId).toBeUndefined();
  });

  it("computes legacy body hash by default for non-empty body", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "POST",
      uri: "/v1/session/init",
      body: JSON.stringify({ scopes: ["test"], granteeAddress: "0x123" }),
    });

    const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);

    expect(payload.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    // Should not be empty (non-empty body)
    expect(payload.bodyHash).not.toBe("");
  });

  it("uses legacy empty body hash by default when no body provided", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });
    const header = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
    });

    const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);

    expect(payload.bodyHash).toBe("");
  });

  it("supports sha256-prefixed body hashes when requested", async () => {
    const signer = createRequestSigner({
      privateKey: TEST_PRIVATE_KEY,
      bodyHashFormat: "prefixed",
    });

    const nonEmptyHeader = await signer.signRequest({
      aud: "https://example.com",
      method: "POST",
      uri: "/v1/data/test",
      body: JSON.stringify({ scopes: ["test"], granteeAddress: "0x123" }),
    });
    const nonEmptyPayloadBase64 = nonEmptyHeader
      .replace("Web3Signed ", "")
      .split(".")[0];
    const nonEmptyPayload = JSON.parse(
      Buffer.from(nonEmptyPayloadBase64, "base64").toString("utf-8"),
    );
    expect(nonEmptyPayload.bodyHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const emptyHeader = await signer.signRequest({
      aud: "https://example.com",
      method: "GET",
      uri: "/v1/data/test",
    });
    const emptyPayloadBase64 = emptyHeader
      .replace("Web3Signed ", "")
      .split(".")[0];
    const emptyPayload = JSON.parse(
      Buffer.from(emptyPayloadBase64, "base64").toString("utf-8"),
    );
    expect(emptyPayload.bodyHash).toBe(PREFIXED_EMPTY_BODY_HASH);
  });

  it("canonicalizes body before hashing (key order does not matter)", async () => {
    const signer = createRequestSigner({ privateKey: TEST_PRIVATE_KEY });

    const header1 = await signer.signRequest({
      aud: "https://example.com",
      method: "POST",
      uri: "/test",
      body: JSON.stringify({ b: 2, a: 1 }),
    });
    const header2 = await signer.signRequest({
      aud: "https://example.com",
      method: "POST",
      uri: "/test",
      body: JSON.stringify({ a: 1, b: 2 }),
    });

    const getBodyHash = (header: string) => {
      const payloadBase64 = header.replace("Web3Signed ", "").split(".")[0];
      const payloadJson = Buffer.from(payloadBase64, "base64").toString(
        "utf-8",
      );
      return JSON.parse(payloadJson).bodyHash;
    };

    expect(getBodyHash(header1)).toBe(getBodyHash(header2));
  });
});
