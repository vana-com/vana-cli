import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The signature a Personal Server's owner makes over this exact message. The
 * server recovers its owner from it and derives the data encryption key from
 * it, so it is as sensitive as a key.
 */
export const OWNER_BINDING_MESSAGE = "vana-master-key-v1";
export const OWNER_BINDING_INTENT = "personal_server.owner_binding.v1";

export interface OwnerBinding {
  signature: string;
  signerAddress: string;
  /**
   * Account's proof that this owner approved this client, needed later to
   * register the server. Present for public native clients such as the CLI.
   */
  trustToken: string | null;
}

export interface OwnerBindingDeps {
  fetchImpl?: typeof fetch;
  openBrowser: (url: string) => void;
  /** Called with the confirmation URL, so a person can open it by hand. */
  onConfirmationUrl?: (url: string) => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Vana CLI</title>
<body style="font-family:system-ui;margin:4rem"><h1>Done</h1><p>You can close this tab and return to the terminal.</p></body>`;
const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>Vana CLI</title>
<body style="font-family:system-ui;margin:4rem"><h1>That did not work</h1><p>Return to the terminal for details.</p></body>`;

/**
 * Wait for Account to send the browser back to this machine with the
 * exchange's one-time code. Listens on 127.0.0.1 only, accepts exactly one
 * request whose state matches, and closes.
 */
async function startLoopbackCallback(expectedState: string): Promise<{
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}> {
  let settle: {
    resolve: (code: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/signing/callback") {
      response.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get("state");
    const received = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (state !== expectedState) {
      // Not ours; keep waiting for the real callback.
      response.writeHead(400, { "content-type": "text/html" }).end(FAILED_PAGE);
      return;
    }
    if (error || !received) {
      response.writeHead(200, { "content-type": "text/html" }).end(FAILED_PAGE);
      settle?.reject(
        new Error(
          error === "access_denied"
            ? "The request was declined in the browser."
            : `Account returned ${error ?? "no code"}.`,
        ),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(DONE_PAGE);
    settle?.resolve(received);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/signing/callback`,
    code,
    close: () => server.close(),
  };
}

/** What Account returns when an exchange is redeemed. */
export interface RedeemedExchange {
  status?: string;
  signature?: string;
  signerAddress?: string;
  desktopSigningTrustToken?: string;
  typedData?: unknown;
}

/**
 * Run one Account signing exchange: the person confirms in the browser, and
 * the result comes back to a one-time loopback listener, bound to this
 * process by state and PKCE. `step` names the request in error messages.
 */
export async function runSigningExchange(
  input: {
    accountUrl: string;
    accessToken: string;
    intent: string;
    payload?: Record<string, unknown>;
    step: string;
  },
  deps: OwnerBindingDeps,
): Promise<RedeemedExchange> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const account = input.accountUrl.replace(/\/+$/, "");
  const state = base64url(crypto.randomBytes(32));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  const callback = await startLoopbackCallback(state);

  try {
    const created = await fetchImpl(`${account}/api/v1/signing-exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        intent: input.intent,
        ...(input.payload ? { payload: input.payload } : {}),
        redirectUri: callback.redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      }),
    });
    if (!created.ok) {
      throw new Error(
        await describeFailure(`start the ${input.step}`, created),
      );
    }
    const { confirmationUrl } = (await created.json()) as {
      confirmationUrl?: string;
    };
    if (!confirmationUrl) {
      throw new Error("Account did not return a confirmation page.");
    }
    deps.onConfirmationUrl?.(confirmationUrl);
    deps.openBrowser(confirmationUrl);

    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;
    const code = await Promise.race([
      callback.code,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Nobody confirmed in the browser in time.")),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    const redeemed = await fetchImpl(
      `${account}/api/v1/signing-exchanges/redeem`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.accessToken}`,
        },
        body: JSON.stringify({
          code,
          state,
          codeVerifier,
          redirectUri: callback.redirectUri,
        }),
      },
    );
    if (!redeemed.ok) {
      throw new Error(
        await describeFailure(`finish the ${input.step}`, redeemed),
      );
    }
    const body = (await redeemed.json()) as RedeemedExchange;
    if (body.status !== "signed" || !body.signature || !body.signerAddress) {
      throw new Error(
        `Account answered the ${input.step} without a signature.`,
      );
    }
    return body;
  } finally {
    callback.close();
  }
}

/**
 * Get the owner-binding signature through Account's signing exchange: Account
 * never signs it silently for the CLI, so the person confirms in the browser.
 */
export async function runOwnerBindingExchange(
  input: { accountUrl: string; accessToken: string },
  deps: OwnerBindingDeps,
): Promise<OwnerBinding> {
  const body = await runSigningExchange(
    { ...input, intent: OWNER_BINDING_INTENT, step: "owner confirmation" },
    deps,
  );
  return {
    signature: body.signature as string,
    signerAddress: body.signerAddress as string,
    trustToken: body.desktopSigningTrustToken ?? null,
  };
}

export async function describeFailure(
  step: string,
  response: Response,
): Promise<string> {
  let code = "";
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    code = body.error?.code ?? "";
  } catch {
    // Not JSON.
  }
  if (response.status === 401) {
    return `Could not ${step}: your vana login is not accepted. Run \`vana login\` again.`;
  }
  if (
    code === "client_not_allowed" ||
    code === "intent_not_allowed_for_client"
  ) {
    return `Could not ${step}: this Vana Account does not let the CLI run a Personal Server yet (${code}).`;
  }
  return `Could not ${step} (HTTP ${response.status}${code ? `, ${code}` : ""}).`;
}
