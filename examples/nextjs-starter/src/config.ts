import "server-only";
import {
  createDirectDataController,
  PaymentRequiredError,
  type PersonalServerFetch,
} from "@opendatalabs/vana-sdk/server";
import { createVanaConfig } from "vana-cli/server";

const SCOPES = ["chatgpt.conversations"];
const environment = process.env.VANA_ENV ?? "dev";
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

export const config = createVanaConfig({
  privateKey,
  scopes: SCOPES,
  appUrl: process.env.APP_URL ?? "",
  environment,
});

const fetchWithoutPayment: PersonalServerFetch = async (url, init) => {
  const response = await fetch(url, init);
  // The SDK can sign a 402 challenge without a separate escrow call.
  // Refuse it before the SDK sees the response or authorizes a payment.
  if (response.status === 402) {
    throw new PaymentRequiredError(
      "Payment required. This starter does not authorize payments.",
    );
  }
  return response;
};

export const vana = createDirectDataController({
  appPrivateKey: config.privateKey,
  app: {
    id: "nextjs-starter",
    name: "Vana Starter",
    homepageUrl: config.appUrl,
  },
  source: "chatgpt",
  scopes: config.scopes,
  env: environment === "dev" ? "dev" : "production",
  personalServerFetch: fetchWithoutPayment,
  personalServerTransportRetry: { attempts: 1 },
});
