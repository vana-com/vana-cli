import "server-only";
import {
  createDirectDataController,
  PaymentRequiredError,
  type PersonalServerFetch,
} from "@opendatalabs/vana-sdk/server";
import { privateKeyToAccount } from "viem/accounts";
import { createVanaConfig } from "vana-cli/server";

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
