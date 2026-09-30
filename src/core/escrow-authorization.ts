/**
 * Gasless escrow deposits: EIP-3009 `ReceiveWithAuthorization` signed by the
 * app key, relayed by the gateway (`POST /v1/escrow/deposit-with-authorization`).
 *
 * The app key signs one typed-data message over the TOKEN's EIP-712 domain,
 * with `to` = the escrow contract. The gateway relayer broadcasts
 * `depositTokenWithAuthorization` and pays the gas, so an app wallet that
 * holds only USDC.e can fund its escrow. The beneficiary is committed inside
 * the signed nonce (`keccak256(abi.encode(account, salt))`), which the escrow
 * recomputes on chain, so neither the gateway nor anyone relaying the body can
 * redirect the deposit.
 *
 * Mirrors the Vana Account builder UI (unity-surfaces
 * apps/account/src/lib/developers/escrow-authorization.ts).
 */

import {
  encodeAbiParameters,
  hashDomain,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import type { LocalAccount } from "viem/accounts";

export interface Erc3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Long enough to relay, short enough to bound a leaked authorization. */
export const AUTHORIZATION_TTL_SEC = 3600;

/** The body `POST /v1/escrow/deposit-with-authorization` takes; all strings. */
export interface DepositAuthorization {
  account: Hex;
  from: Hex;
  token: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  salt: Hex;
  signature: Hex;
}

/**
 * The escrow recomputes the EIP-3009 nonce on chain as
 * keccak256(abi.encode(account, salt)). The signature must cover exactly this
 * nonce; it is what pins the beneficiary.
 */
export function deriveEscrowAuthorizationNonce(account: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [account, salt],
    ),
  );
}

/** Fresh 32 random bytes. An authorization is single-use per (account, salt). */
export function generateAuthorizationSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function computeErc3009DomainSeparator(domain: Erc3009Domain): Hex {
  return hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: { EIP712Domain: [...EIP712_DOMAIN_TYPE] },
  });
}

/**
 * The gateway wants 65-byte r||s||v with v in {27, 28} and rejects EIP-2098
 * compact signatures. viem's local signer already returns v in {27, 28}; a
 * {0, 1} v is normalised rather than trusted to be rejected downstream.
 */
export function normalizeAuthorizationSignature(value: string): Hex | null {
  if (!/^0x[a-fA-F0-9]{130}$/.test(value)) {
    return null;
  }
  const v = Number.parseInt(value.slice(-2), 16);
  if (v === 27 || v === 28) {
    return value as Hex;
  }
  if (v === 0 || v === 1) {
    return `${value.slice(0, -2)}${(v + 27).toString(16)}` as Hex;
  }
  return null;
}

const ERC3009_DOMAIN_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

export interface Erc3009DomainReader {
  readContract(args: {
    abi: typeof ERC3009_DOMAIN_ABI;
    address: Hex;
    functionName: "name" | "version" | "DOMAIN_SEPARATOR";
  }): Promise<unknown>;
}

/**
 * Resolve the token's EIP-712 domain from chain state and prove it by
 * recomputing the token's own DOMAIN_SEPARATOR(). A wrong name or version
 * signs perfectly well and is rejected by the token (gateway 409), so a domain
 * that does not reproduce the separator is an error, never a guess.
 */
export async function resolveErc3009Domain(
  client: Erc3009DomainReader,
  input: { chainId: number; token: Hex },
): Promise<Erc3009Domain> {
  const read = (functionName: "name" | "version" | "DOMAIN_SEPARATOR") =>
    client.readContract({
      abi: ERC3009_DOMAIN_ABI,
      address: input.token,
      functionName,
    });
  const [name, onChainSeparator] = (await Promise.all([
    read("name"),
    read("DOMAIN_SEPARATOR"),
  ])) as [string, Hex];
  const reported = (await read("version").catch(() => null)) as string | null;

  const seen = new Set<string>();
  for (const version of [...(reported === null ? [] : [reported]), "2", "1"]) {
    if (seen.has(version)) {
      continue;
    }
    seen.add(version);
    const domain: Erc3009Domain = {
      name,
      version,
      chainId: input.chainId,
      verifyingContract: input.token,
    };
    if (
      computeErc3009DomainSeparator(domain).toLowerCase() ===
      onChainSeparator.toLowerCase()
    ) {
      return domain;
    }
  }
  throw new Error(
    `Could not verify the EIP-712 domain of token ${input.token}: no version reproduces its DOMAIN_SEPARATOR, so it may not support gasless deposits`,
  );
}

/**
 * Sign a deposit of `value` base units of `token` into `account`'s escrow,
 * paid from `signer`'s own token balance.
 */
export async function signDepositAuthorization(input: {
  signer: LocalAccount;
  domain: Erc3009Domain;
  escrowContract: Hex;
  account: Hex;
  value: bigint;
  now?: () => number;
  salt?: Hex;
}): Promise<DepositAuthorization> {
  const nowSec = Math.floor((input.now ?? Date.now)() / 1000);
  // A little slack below now, so a signer clock slightly ahead of the chain
  // does not produce an authorization that is not yet valid.
  const validAfter = BigInt(Math.max(0, nowSec - 60));
  const validBefore = BigInt(nowSec + AUTHORIZATION_TTL_SEC);
  const salt = input.salt ?? generateAuthorizationSalt();
  const nonce = deriveEscrowAuthorizationNonce(input.account, salt);

  const raw = await input.signer.signTypedData({
    domain: { ...input.domain, chainId: BigInt(input.domain.chainId) },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: input.signer.address,
      // Always the escrow contract, never the gateway.
      to: input.escrowContract,
      value: input.value,
      validAfter,
      validBefore,
      nonce,
    },
  });
  const signature = normalizeAuthorizationSignature(raw);
  if (!signature) {
    throw new Error("The signer returned a signature the gateway cannot use");
  }
  return {
    account: input.account,
    from: input.signer.address,
    token: input.domain.verifyingContract,
    value: input.value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    salt,
    signature,
  };
}

/** A gateway answer that is not 202, with its meaning kept apart. */
export class DepositAuthorizationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** 409: permanent for this body; sign a fresh authorization. */
    public readonly rejected: boolean,
    /** 502: nothing was broadcast; the same body is safe to resend. */
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "DepositAuthorizationError";
  }
}

/**
 * Hand a signed authorization to the gateway relayer. 202 means the deposit
 * was broadcast and the gateway already holds its deposit row: there is no
 * second "register the tx hash" step, unlike a self-broadcast deposit.
 */
export async function submitDepositAuthorization(
  gatewayUrl: string,
  authorization: DepositAuthorization,
  fetchImpl: typeof fetch = fetch,
): Promise<{ txHash: Hex; status: string }> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${gatewayUrl.replace(/\/+$/, "")}/v1/escrow/deposit-with-authorization`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(authorization),
      },
    );
  } catch (error) {
    // No HTTP answer at all (DNS, TLS, offline). The gateway may or may not
    // have broadcast before the connection dropped, so this is "unreachable",
    // and a re-run should check the balance before signing again.
    throw new DepositAuthorizationError(
      `Could not reach the gateway relayer: ${
        error instanceof Error ? error.message : String(error)
      }`,
      0,
      false,
      true,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (response.status !== 202) {
    const message =
      typeof record.error === "string"
        ? record.error
        : `Gateway answered ${response.status}`;
    throw new DepositAuthorizationError(
      message,
      response.status,
      response.status === 409,
      response.status === 502,
    );
  }
  const txHash = record.txHash;
  if (typeof txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new DepositAuthorizationError(
      "Gateway accepted the deposit but returned no transaction hash",
      response.status,
      false,
      false,
    );
  }
  return {
    txHash: txHash as Hex,
    status: typeof record.status === "string" ? record.status : "submitted",
  };
}

export type DepositSettlement = "finalized" | "failed" | "pending";

/**
 * Wait for the gateway to credit a relayed deposit. The gateway only moves a
 * relayed deposit from pending to available when something asks it to
 * reconcile (`POST /v1/escrow/balance/sync`); a plain balance read keeps
 * showing it pending. The builder UI polls the same way.
 */
export async function awaitDepositSettlement(
  gatewayUrl: string,
  account: Hex,
  txHash: Hex,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<DepositSettlement> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 90_000);
  const wanted = txHash.toLowerCase();
  const url = `${gatewayUrl.replace(/\/+$/, "")}/v1/escrow/balance/sync?account=${encodeURIComponent(account)}`;
  for (;;) {
    try {
      const response = await fetchImpl(url, { method: "POST" });
      if (response.ok) {
        const body = (await response.json()) as {
          data?: { deposits?: Record<string, { txHash?: string }[]> };
          deposits?: Record<string, { txHash?: string }[]>;
        };
        const deposits = body.data?.deposits ?? body.deposits ?? {};
        const has = (state: string) =>
          (deposits[state] ?? []).some(
            (d) => d.txHash?.toLowerCase() === wanted,
          );
        if (has("finalized")) return "finalized";
        if (has("failed")) return "failed";
      }
    } catch {
      // A failed sync is not a failed deposit; keep asking until the deadline.
    }
    if (now() >= deadline) return "pending";
    await sleep(options.intervalMs ?? 3000);
  }
}
