import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OWNER_BINDING_INTENT,
  runOwnerBindingExchange,
} from "../../src/personal-server/local/owner-binding.js";

const ACCOUNT = "https://account-dev.vana.org";

interface Created {
  intent: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/**
 * A fake Account plus a fake browser: opening the confirmation page "approves"
 * it by sending the loopback callback the way Account's redirect would.
 */
function fakeAccount(
  options: {
    createStatus?: number;
    createError?: string;
    callbackQuery?: (created: Created) => string;
    redeemBody?: Record<string, unknown>;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let created: Created | null = null;
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    if (target === `${ACCOUNT}/api/v1/signing-exchanges`) {
      created = JSON.parse(String(init?.body)) as Created;
      if (options.createStatus && options.createStatus !== 200) {
        return new Response(
          JSON.stringify({ error: { code: options.createError } }),
          { status: options.createStatus },
        );
      }
      return new Response(
        JSON.stringify({
          id: "ex_1",
          confirmationUrl: `${ACCOUNT}/signing-exchanges/ex_1?state=${created.state}`,
        }),
        { status: 200 },
      );
    }
    if (target === `${ACCOUNT}/api/v1/signing-exchanges/redeem`) {
      return new Response(
        JSON.stringify(
          options.redeemBody ?? {
            status: "signed",
            intent: OWNER_BINDING_INTENT,
            signature: "0xsig",
            signerAddress: "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d",
            desktopSigningTrustToken: "trust_1",
          },
        ),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const openBrowser = () => {
    if (!created) throw new Error("opened before create");
    const query =
      options.callbackQuery?.(created) ??
      `code=code_1&state=${encodeURIComponent(created.state)}`;
    void fetch(`${created.redirectUri}?${query}`).catch(() => {});
  };
  return { fetchImpl, openBrowser, calls, created: () => created };
}

describe("runOwnerBindingExchange", () => {
  it("creates an owner-binding exchange, waits for the browser, and redeems with PKCE", async () => {
    const account = fakeAccount();
    const binding = await runOwnerBindingExchange(
      { accountUrl: ACCOUNT, accessToken: "token_1" },
      { fetchImpl: account.fetchImpl, openBrowser: account.openBrowser },
    );

    expect(binding).toEqual({
      signature: "0xsig",
      signerAddress: "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d",
      trustToken: "trust_1",
    });
    const created = account.created();
    expect(created?.intent).toBe(OWNER_BINDING_INTENT);
    expect(created?.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/signing\/callback$/,
    );
    expect(created?.codeChallengeMethod).toBe("S256");

    const redeem = account.calls.find((call) => call.url.endsWith("/redeem"));
    const body = JSON.parse(String(redeem?.init.body)) as Record<
      string,
      string
    >;
    expect(body.code).toBe("code_1");
    expect(body.state).toBe(created?.state);
    expect(body.redirectUri).toBe(created?.redirectUri);
    expect(
      crypto.createHash("sha256").update(body.codeVerifier).digest("base64url"),
    ).toBe(created?.codeChallenge);
    expect((redeem?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer token_1",
    );
  });

  it("ignores a callback with the wrong state and keeps waiting", async () => {
    const account = fakeAccount({
      callbackQuery: () => "code=evil&state=wrong",
    });
    await expect(
      runOwnerBindingExchange(
        { accountUrl: ACCOUNT, accessToken: "token_1" },
        {
          fetchImpl: account.fetchImpl,
          openBrowser: account.openBrowser,
          timeoutMs: 300,
        },
      ),
    ).rejects.toThrow(/in time/);
    expect(account.calls.some((call) => call.url.endsWith("/redeem"))).toBe(
      false,
    );
  });

  it("reports a decline in the browser", async () => {
    const account = fakeAccount({
      callbackQuery: (created) =>
        `error=access_denied&state=${encodeURIComponent(created.state)}`,
    });
    await expect(
      runOwnerBindingExchange(
        { accountUrl: ACCOUNT, accessToken: "token_1" },
        { fetchImpl: account.fetchImpl, openBrowser: account.openBrowser },
      ),
    ).rejects.toThrow(/declined/);
  });

  it("explains an Account that does not allow the CLI yet", async () => {
    const account = fakeAccount({
      createStatus: 403,
      createError: "client_not_allowed",
    });
    await expect(
      runOwnerBindingExchange(
        { accountUrl: ACCOUNT, accessToken: "token_1" },
        { fetchImpl: account.fetchImpl, openBrowser: account.openBrowser },
      ),
    ).rejects.toThrow(
      /does not let the CLI run a Personal Server yet \(client_not_allowed\)/,
    );
  });

  it("refuses a redeem that carries no signature", async () => {
    const account = fakeAccount({ redeemBody: { status: "pending" } });
    await expect(
      runOwnerBindingExchange(
        { accountUrl: ACCOUNT, accessToken: "token_1" },
        { fetchImpl: account.fetchImpl, openBrowser: account.openBrowser },
      ),
    ).rejects.toThrow(/without a signature/);
  });
});
