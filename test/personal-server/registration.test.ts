import { describe, expect, it, vi } from "vitest";

import {
  RegistrationNeedsBrowserError,
  SERVER_REGISTRATION_INTENT,
  signServerRegistration,
} from "../../src/personal-server/local/registration.js";

const ACCOUNT = "https://account-dev.vana.org";
const OWNER = "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d";

const request = {
  typedData: {
    domain: {
      chainId: "14800",
      verifyingContract: "0xCae2CE0e9caa6643ed28186cF57bd40Bd9E17Eab",
    },
    message: {
      serverAddress: "0x1111111111111111111111111111111111111111",
      publicKey: "0x04abc",
      serverUrl: "https://0x1111.server-dev.vana.org",
    },
  },
};

function account(silent: Record<string, unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(silent), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("signServerRegistration", () => {
  it("signs silently with the trust token from the owner confirmation", async () => {
    const fake = account({
      status: "signed",
      signature: "0xreg",
      signerAddress: OWNER,
    });
    const result = await signServerRegistration(
      {
        accountUrl: ACCOUNT,
        accessToken: "token_1",
        trustToken: "trust_1",
        request,
        allowBrowser: true,
      },
      { fetchImpl: fake.fetchImpl, openBrowser: vi.fn() },
    );
    expect(result).toEqual({
      signature: "0xreg",
      signerAddress: OWNER,
      via: "silent",
    });
    const [call] = fake.calls;
    expect(call.url).toBe(
      `${ACCOUNT}/api/v1/intents/personal-server-registration/sign`,
    );
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token_1");
    expect(headers["x-vana-desktop-trust-token"]).toBe("trust_1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      intent: SERVER_REGISTRATION_INTENT,
      serverAddress: request.typedData.message.serverAddress,
      serverPublicKey: "0x04abc",
      serverUrl: request.typedData.message.serverUrl,
      chainId: 14800,
      verifyingContract: request.typedData.domain.verifyingContract,
    });
  });

  it("does not open a browser when the person cannot answer", async () => {
    const fake = account({
      status: "confirmation_required",
      code: "desktop_trust_token_required",
    });
    const openBrowser = vi.fn();
    await expect(
      signServerRegistration(
        {
          accountUrl: ACCOUNT,
          accessToken: "token_1",
          trustToken: null,
          request,
          allowBrowser: false,
        },
        { fetchImpl: fake.fetchImpl, openBrowser },
      ),
    ).rejects.toBeInstanceOf(RegistrationNeedsBrowserError);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("refuses a request without the fields Account signs", async () => {
    const fake = account({ status: "signed", signature: "0x" });
    await expect(
      signServerRegistration(
        {
          accountUrl: ACCOUNT,
          accessToken: "token_1",
          trustToken: null,
          request: { typedData: { message: { serverAddress: "0x1" } } },
          allowBrowser: true,
        },
        { fetchImpl: fake.fetchImpl, openBrowser: vi.fn() },
      ),
    ).rejects.toThrow(/incomplete/);
    expect(fake.calls).toHaveLength(0);
  });

  it("falls back to the browser exchange with the registration payload", async () => {
    let created: Record<string, unknown> | null = null;
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const target = String(url);
      if (target.endsWith("/personal-server-registration/sign")) {
        return new Response(
          JSON.stringify({
            status: "confirmation_required",
            code: "embedded_wallet_not_available",
          }),
        );
      }
      if (target.endsWith("/api/v1/signing-exchanges")) {
        created = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ confirmationUrl: `${ACCOUNT}/signing-exchanges/1` }),
        );
      }
      if (target.endsWith("/redeem")) {
        return new Response(
          JSON.stringify({
            status: "signed",
            intent: SERVER_REGISTRATION_INTENT,
            signature: "0xexternal",
            signerAddress: OWNER,
          }),
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const openBrowser = () => {
      const body = created as { redirectUri: string; state: string };
      void fetch(
        `${body.redirectUri}?code=c1&state=${encodeURIComponent(body.state)}`,
      ).catch(() => {});
    };

    const result = await signServerRegistration(
      {
        accountUrl: ACCOUNT,
        accessToken: "token_1",
        trustToken: null,
        request,
        allowBrowser: true,
      },
      { fetchImpl, openBrowser },
    );
    expect(result).toEqual({
      signature: "0xexternal",
      signerAddress: OWNER,
      via: "browser",
    });
    expect(created).toMatchObject({
      intent: SERVER_REGISTRATION_INTENT,
      payload: {
        serverAddress: request.typedData.message.serverAddress,
        serverUrl: request.typedData.message.serverUrl,
      },
    });
  });
});
