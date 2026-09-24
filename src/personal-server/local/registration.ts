import {
  describeFailure,
  runSigningExchange,
  type OwnerBindingDeps,
} from "./owner-binding.js";

export const SERVER_REGISTRATION_INTENT =
  "personal_server.server_registration.v1";
const SIGN_PATH = "/api/v1/intents/personal-server-registration/sign";

/** What the server's prepareRegistration() returns; the CLI only reads the typed data. */
export interface RegistrationRequest {
  typedData: {
    domain?: { chainId?: number | string; verifyingContract?: string };
    message?: {
      serverAddress?: string;
      publicKey?: string;
      serverUrl?: string;
    };
  };
}

/** Account needs the browser: the silent path is closed for this owner or client. */
export class RegistrationNeedsBrowserError extends Error {
  constructor(readonly code: string) {
    super(
      `Registering needs you to confirm in a browser (${code}). Run without --no-input.`,
    );
  }
}

export interface RegistrationSignature {
  signature: string;
  signerAddress: string | null;
  via: "silent" | "browser";
}

/** The fields Account signs, from the server's own registration request. */
export function registrationPayload(
  request: RegistrationRequest,
): Record<string, unknown> {
  const message = request.typedData?.message;
  const domain = request.typedData?.domain;
  if (!(message?.serverAddress && message.publicKey && message.serverUrl)) {
    throw new Error("The server's registration request is incomplete.");
  }
  const chainId = Number(domain?.chainId);
  return {
    serverAddress: message.serverAddress,
    serverPublicKey: message.publicKey,
    serverUrl: message.serverUrl,
    ...(Number.isInteger(chainId) ? { chainId } : {}),
    ...(typeof domain?.verifyingContract === "string"
      ? { verifyingContract: domain.verifyingContract }
      : {}),
  };
}

/**
 * Have Account sign the server's registration as its owner. Account signs
 * silently when the owner's wallet lives in Account and the trust token from
 * the owner confirmation is valid, as it does for Desktop; otherwise the
 * person confirms in the browser.
 */
export async function signServerRegistration(
  input: {
    accountUrl: string;
    accessToken: string;
    trustToken: string | null;
    request: RegistrationRequest;
    allowBrowser: boolean;
  },
  deps: OwnerBindingDeps,
): Promise<RegistrationSignature> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const account = input.accountUrl.replace(/\/+$/, "");
  const payload = registrationPayload(input.request);

  const response = await fetchImpl(`${account}${SIGN_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.accessToken}`,
      ...(input.trustToken
        ? { "x-vana-desktop-trust-token": input.trustToken }
        : {}),
    },
    body: JSON.stringify({ intent: SERVER_REGISTRATION_INTENT, ...payload }),
  });
  if (!response.ok) {
    throw new Error(await describeFailure("sign the registration", response));
  }
  const body = (await response.json()) as {
    status?: string;
    code?: string;
    signature?: string;
    signerAddress?: string;
  };
  if (body.status === "signed" && body.signature) {
    return {
      signature: body.signature,
      signerAddress: body.signerAddress ?? null,
      via: "silent",
    };
  }
  if (body.status !== "confirmation_required") {
    throw new Error(
      `Account did not sign the registration (${body.code ?? body.status ?? "unknown"}).`,
    );
  }
  if (!input.allowBrowser) {
    throw new RegistrationNeedsBrowserError(
      body.code ?? "confirmation_required",
    );
  }
  const redeemed = await runSigningExchange(
    {
      accountUrl: input.accountUrl,
      accessToken: input.accessToken,
      intent: SERVER_REGISTRATION_INTENT,
      payload,
      step: "registration",
    },
    deps,
  );
  return {
    signature: redeemed.signature as string,
    signerAddress: redeemed.signerAddress ?? null,
    via: "browser",
  };
}
