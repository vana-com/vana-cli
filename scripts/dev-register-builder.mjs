#!/usr/bin/env node
/**
 * dev-register-builder.mjs — Register a throwaway dev builder on the Vana
 * DEV Data Gateway (https://dp-rpc-dev.vana.org) so the dev session relay
 * (https://dev.session-relay.vana.org) can verify it via
 * GET /v1/builders/{granteeAddress} (HTTP 200).
 *
 * Protocol (data-gateway, origin/dev — `api/v1/builders.ts` + `lib/eip712.ts`):
 *   POST {GATEWAY}/v1/builders
 *     Content-Type: application/json
 *     Authorization: Web3Signed <65-byte EIP-712 signature, hex>
 *     body: { ownerAddress, granteeAddress, publicKey, appUrl? }
 *
 *   EIP-712 domain:
 *     { name: 'Vana Data Portability', version: '1',
 *       chainId: <dev CHAIN_ID>, verifyingContract: DATA_PORTABILITY_GRANTEES_CONTRACT }
 *   types (primaryType 'BuilderRegistration'):
 *     ownerAddress: address, granteeAddress: address,
 *     publicKey: string, appUrl: string
 *
 *   - Signed by the OWNER (recovered signer must equal ownerAddress).
 *   - publicKey = grantee's UNCOMPRESSED key (0x04 + 128 hex chars) and must
 *     derive to granteeAddress.
 *   - 201 = registered, 409 = already registered, 401 = bad signature.
 *   No admin approval, no captcha, no on-chain tx for gateway registration.
 *
 * Env (all optional):
 *   VANA_BUILDER_PRIVATE_KEY        grantee private key (freshly generated if unset)
 *   VANA_BUILDER_OWNER_PRIVATE_KEY  owner private key   (freshly generated if unset)
 *   VANA_BUILDER_APP_URL            appUrl to register  (default '')
 *   GATEWAY_URL                     default https://dp-rpc-dev.vana.org
 *   CHAIN_ID / DATA_PORTABILITY_GRANTEES_CONTRACT
 *                                   default to the dev deployment values
 *
 * Idempotent: if the grantee is already registered (GET -> 200), the script
 * prints the stored record and exits without re-registering.
 *
 * SECURITY: generated private keys are printed to stdout so the session can
 * be resumed. They are DEV THROWAWAYS - never reuse them for anything real,
 * never point GATEWAY_URL at a production gateway, and never paste the
 * output into a shared channel.
 *
 * Usage: node scripts/dev-register-builder.mjs
 */

import { isAddress, getAddress } from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  publicKeyToAddress,
} from "viem/accounts";

const GATEWAY_URL = (
  process.env.GATEWAY_URL ?? "https://dp-rpc-dev.vana.org"
).replace(/\/$/, "");

// Dev deployment env (see data-gateway origin/dev: .env.example, scripts/register-app.ts;
// prod deployment uses CHAIN_ID=1480 per vana-cli connect admin register-builder.ts).
// The deployed dev gateway's env cannot be read directly, so on a 401
// "signature verification failed" we retry with the documented prod domain
// (1480) — two documented configurations, no brute force.
const GRANTEEES_CONTRACT = (
  process.env.DATA_PORTABILITY_GRANTEES_CONTRACT ??
  "0x8325C0A0948483EdA023A1A2Fd895e62C5131234"
).toLowerCase();
const PRIMARY_CHAIN_ID = process.env.CHAIN_ID
  ? BigInt(process.env.CHAIN_ID)
  : 14800n;
const CHAIN_ID_CANDIDATES =
  PRIMARY_CHAIN_ID === 1480n ? [1480n] : [PRIMARY_CHAIN_ID, 1480n];

const DOMAIN = { name: "Vana Data Portability", version: "1" };
const TYPES = {
  BuilderRegistration: [
    { name: "ownerAddress", type: "address" },
    { name: "granteeAddress", type: "address" },
    { name: "publicKey", type: "string" },
    { name: "appUrl", type: "string" },
  ],
};
const PRIMARY_TYPE = "BuilderRegistration";

async function http(
  path,
  { method = "GET", headers = {}, body, timeoutMs = 20000 } = {},
) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: body
      ? { "Content-Type": "application/json", ...headers }
      : { ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data };
}

function keyFromEnv(name, label) {
  const v = process.env[name];
  if (v) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      console.error(`FAIL: ${name} is not a 32-byte hex key`);
      process.exit(2);
    }
    const account = privateKeyToAccount(v);
    console.log(`${label}: ${account.address} (from ${name})`);
    return { account, privateKey: v, generated: false };
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`${label}: ${account.address} (freshly generated)`);
  return { account, privateKey, generated: true };
}

async function uncompressedPublicKey(account, privateKeyHex) {
  // viem >=2.x privateKeyToAccount exposes the UNCOMPRESSED key as .publicKey.
  const pk = account.publicKey;
  if (typeof pk === "string" && /^0x04[0-9a-fA-F]{128}$/.test(pk)) return pk;
  // Fallback: derive via @noble/curves (transitive viem dependency).
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const point = secp256k1.ProjectivePoint.fromPrivateKey(
    privateKeyHex.slice(2),
  );
  return `0x${point.toHex(false)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`Gateway: ${GATEWAY_URL}`);

  const grantee = keyFromEnv("VANA_BUILDER_PRIVATE_KEY", "Grantee (builder)");
  const owner = keyFromEnv("VANA_BUILDER_OWNER_PRIVATE_KEY", "Owner (signer)");
  const appUrl = process.env.VANA_BUILDER_APP_URL ?? "";

  // Grantee public key (uncompressed) and sanity checks.
  const publicKey = await uncompressedPublicKey(grantee.account);
  const derivedFromPub = publicKeyToAddress(publicKey);
  if (derivedFromPub.toLowerCase() !== grantee.account.address.toLowerCase()) {
    console.error(
      `FAIL: derived address ${derivedFromPub} != grantee ${grantee.account.address}`,
    );
    process.exit(2);
  }
  if (!isAddress(owner.account.address)) process.exit(2);
  const ownerAddress = getAddress(owner.account.address);
  const granteeAddress = getAddress(grantee.account.address);

  // --- Idempotency: already registered? ---
  const pre = await http(`/v1/builders/${granteeAddress}`);
  if (pre.status === 200) {
    console.log(
      "\nAlready registered (GET /v1/builders -> 200). Stored record:",
    );
    console.log(JSON.stringify(pre.data.data, null, 2));
    console.log(`\nGrantee address:    ${granteeAddress}`);
    console.log(`Grantee private key: ${grantee.privateKey}`);
    return;
  }
  if (pre.status !== 404) {
    console.error(
      `FAIL: unexpected pre-check status ${pre.status}: ${JSON.stringify(pre.data)}`,
    );
    process.exit(1);
  }
  console.log("Not registered yet (pre-check 404). Registering...");

  // --- Sign + submit, across the documented domain candidates ---
  const message = { ownerAddress, granteeAddress, publicKey, appUrl };
  let post = null;
  let usedChainId = null;
  for (const chainId of CHAIN_ID_CANDIDATES) {
    const domain = {
      ...DOMAIN,
      chainId,
      verifyingContract: GRANTEEES_CONTRACT,
    };
    console.log(
      `\nTrying EIP-712 domain chainId=${chainId}, verifyingContract=${GRANTEEES_CONTRACT}`,
    );
    const signature = await owner.account.signTypedData({
      domain,
      types: TYPES,
      primaryType: PRIMARY_TYPE,
      message,
    });
    post = await http("/v1/builders", {
      method: "POST",
      headers: { Authorization: `Web3Signed ${signature}` },
      body: message,
    });
    console.log(
      `POST /v1/builders -> ${post.status}: ${JSON.stringify(post.data)}`,
    );
    if (post.status === 201 || post.status === 409) {
      usedChainId = chainId;
      break;
    }
    if (post.status !== 401) {
      console.error(
        `FAIL: POST rejected with non-signature error ${post.status}`,
      );
      process.exit(1);
    }
    // 401: either signature truly invalid (shouldn't happen locally) or wrong domain.
    if (
      !/signature/i.test(JSON.stringify(post.data.error ?? post.data.raw ?? ""))
    ) {
      console.error(
        "FAIL: 401 not a signature error; not retrying another domain.",
      );
      process.exit(1);
    }
    console.log(
      "401 signature error — retrying with next documented domain candidate...",
    );
  }

  if (post?.status === 409) {
    console.log(
      "\nAlready registered (POST -> 409). Fetching stored record...",
    );
  } else if (post?.status !== 201) {
    console.error(
      `FAIL: registration failed with ${post?.status}: ${JSON.stringify(post?.data)}`,
    );
    process.exit(1);
  } else {
    console.log(
      `\nRegistered with domain chainId=${usedChainId}. builderId=${post.data.builderId}`,
    );
  }

  // --- Poll GET until 200 (max ~30s) ---
  const deadline = Date.now() + 30_000;
  let record = null;
  while (Date.now() < deadline) {
    const r = await http(`/v1/builders/${granteeAddress}`);
    if (r.status === 200) {
      record = r.data;
      break;
    }
    if (r.status !== 404) {
      console.error(
        `FAIL: unexpected GET status during polling: ${r.status} ${JSON.stringify(r.data)}`,
      );
      process.exit(1);
    }
    await sleep(2000);
  }

  if (!record) {
    console.error("FAIL: GET /v1/builders/<grantee> still not 200 after 30s.");
    process.exit(1);
  }

  console.log("\nSUCCESS — GET /v1/builders/<grantee> -> 200");
  console.log("Stored builder record:");
  console.log(JSON.stringify(record.data, null, 2));
  console.log(`proof.status: ${record.proof?.status ?? "n/a"}`);
  console.log("\n--- Credentials (throwaway dev key) ---");
  console.log(`Grantee address:    ${granteeAddress}`);
  console.log(`Grantee private key: ${grantee.privateKey}`);
  console.log(`Grantee public key: ${publicKey.slice(0, 42)}...`);
  console.log(`Owner address:      ${ownerAddress}`);
  console.log(`appUrl:             ${appUrl}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
