import "server-only";
import {
  createDirectDataController,
  PaymentRequiredError,
  type PersonalServerFetch,
} from "@opendatalabs/vana-sdk/server";
import { privateKeyToAccount } from "viem/accounts";
import { createVanaConfig } from "vana-cli/server";
import path from "node:path";
import { getDirectEndpoints } from "@opendatalabs/vana-sdk/server";
import { createShelf } from "./server/delivery.js";

const environment = process.env.VANA_ENV ?? "prod";
if (environment !== "dev" && environment !== "prod") {
  throw new Error('VANA_ENV must be "dev" or "prod"');
}
const privateKey =
  process.env.VANA_PRIVATE_KEY ?? process.env.VANA_APP_PRIVATE_KEY;
function isPrivateKey(value: string | undefined): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}
if (!isPrivateKey(privateKey)) {
  throw new Error("VANA_PRIVATE_KEY must be a 0x-prefixed, 32-byte app key");
}
const address = privateKeyToAccount(privateKey).address;
if (process.env.VANA_APP_ADDRESS?.toLowerCase() !== address.toLowerCase()) {
  throw new Error("VANA_APP_ADDRESS must match the selected app key");
}
const appUrl = new URL(process.env.APP_URL ?? "http://localhost:3090");
if (
  !["http:", "https:"].includes(appUrl.protocol) ||
  appUrl.username ||
  appUrl.password
) {
  throw new Error("APP_URL must be an HTTP(S) URL without credentials");
}

export const config = createVanaConfig({
  privateKey,
  scopes: ["perplexity.conversations"],
  appUrl: appUrl.href.replace(/\/$/, ""),
  environment,
});

export const vana = createDirectDataController({
  appPrivateKey: config.privateKey,
  app: {
    id: "perplexity-demo",
    name: "Research Shelf",
    homepageUrl: config.appUrl,
  },
  source: "perplexity",
  scopes: config.scopes,
  env: environment === "dev" ? "dev" : "production",
  network: "moksha",
  endpoints: process.env.VANA_APPROVAL_URL
    ? { accessRequestBaseUrl: approvalUrl(), approvalAppBaseUrl: approvalUrl() }
    : undefined,
  personalServerTransportRetry: { attempts: 1 },
  personalServerFetch: (async (url, init) => {
    const response = await fetch(url, init);
    // Refuse the challenge before the SDK can sign or send a payment.
    if (response.status === 402) {
      throw new PaymentRequiredError("This demo does not authorize payments.");
    }
    return response;
  }) satisfies PersonalServerFetch,
});

function approvalUrl(): string {
  const fallback = getDirectEndpoints(
    environment === "dev" ? "dev" : "production",
  ).accessRequestBaseUrl;
  const url = new URL(process.env.VANA_APPROVAL_URL ?? fallback);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.origin !== fallback &&
      !(environment === "dev" && url.origin === "http://localhost:3083"))
  ) {
    throw new Error(
      "VANA_APPROVAL_URL may only select the default host or local dev Web",
    );
  }
  return url.origin;
}

for (const value of [process.env.VANA_MAX_FEE, process.env.VANA_MAX_TOTAL]) {
  if (
    value !== undefined &&
    (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value) || Number(value) <= 0)
  )
    throw new Error(
      "Moksha spending limits must be positive decimals with at most 18 places",
    );
}

export const shelf = createShelf({
  privateKey: config.privateKey,
  environment,
  approvalUrl: approvalUrl(),
  gatewayUrl:
    environment === "dev"
      ? "https://dp-rpc-dev.vana.org"
      : "https://dp-rpc.moksha.vana.org",
  storageDirectory: path.resolve(
    process.env.VANA_SHELF_DIRECTORY ?? ".research-shelf",
  ),
  allowPayment: process.env.VANA_ALLOW_MOKSHA_PAYMENT === "true",
  maxFee: process.env.VANA_MAX_FEE,
  maxTotal: process.env.VANA_MAX_TOTAL,
  resumeRequestId: process.env.VANA_RESUME_REQUEST_ID,
});
