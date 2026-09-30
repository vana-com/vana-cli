import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DepositAuthorizationError,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  awaitDepositSettlement,
  computeErc3009DomainSeparator,
  deriveEscrowAuthorizationNonce,
  normalizeAuthorizationSignature,
  resolveErc3009Domain,
  signDepositAuthorization,
  submitDepositAuthorization,
  type Erc3009Domain,
} from "../../src/core/escrow-authorization.js";

// Anvil account 0: a test key, never a real one.
const signer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const token = "0xF1815bd50389c46847f0Bda824eC8da914045D14" as Hex;
const escrow = "0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3" as Hex;
const domain: Erc3009Domain = {
  name: "Bridged USDC (Stargate)",
  version: "2",
  chainId: 1480,
  verifyingContract: token,
};
const salt = `0x${"11".repeat(32)}` as Hex;

describe("escrow deposit authorization", () => {
  it("derives the nonce the escrow recomputes on chain", () => {
    const account = signer.address;
    expect(deriveEscrowAuthorizationNonce(account, salt)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "bytes32" }],
          [account, salt],
        ),
      ),
    );
  });

  it("signs a ReceiveWithAuthorization to the escrow that recovers to the app key", async () => {
    const auth = await signDepositAuthorization({
      signer,
      domain,
      escrowContract: escrow,
      account: signer.address,
      value: 200000n,
      now: () => 1_790_000_000_000,
      salt,
    });
    expect(auth).toMatchObject({
      account: signer.address,
      from: signer.address,
      token,
      value: "200000",
      validAfter: String(1_790_000_000 - 60),
      validBefore: String(1_790_000_000 + 3600),
      salt,
    });
    const recovered = await recoverTypedDataAddress({
      domain: { ...domain, chainId: 1480n },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: signer.address,
        to: escrow,
        value: 200000n,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: deriveEscrowAuthorizationNonce(signer.address, salt),
      },
      signature: auth.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it("does not verify for a different beneficiary", async () => {
    const auth = await signDepositAuthorization({
      signer,
      domain,
      escrowContract: escrow,
      account: signer.address,
      value: 1n,
      salt,
    });
    const other = "0x000000000000000000000000000000000000dEaD" as Hex;
    const recovered = await recoverTypedDataAddress({
      domain: { ...domain, chainId: 1480n },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: signer.address,
        to: escrow,
        value: 1n,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: deriveEscrowAuthorizationNonce(other, salt),
      },
      signature: auth.signature,
    });
    expect(recovered).not.toBe(signer.address);
  });

  it("normalises v in {0,1} and refuses compact signatures", () => {
    const body = "ab".repeat(64);
    expect(normalizeAuthorizationSignature(`0x${body}1b`)).toBe(`0x${body}1b`);
    expect(normalizeAuthorizationSignature(`0x${body}00`)).toBe(`0x${body}1b`);
    expect(normalizeAuthorizationSignature(`0x${body}01`)).toBe(`0x${body}1c`);
    expect(normalizeAuthorizationSignature(`0x${"ab".repeat(64)}`)).toBeNull();
  });

  it("proves the token domain against its DOMAIN_SEPARATOR", async () => {
    const separator = computeErc3009DomainSeparator(domain);
    const reader = (version: string | Error) => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "name") return domain.name;
        if (functionName === "DOMAIN_SEPARATOR") return separator;
        if (version instanceof Error) throw version;
        return version;
      },
    });
    // A token that reports a wrong version still resolves to the one that
    // reproduces its separator; one without version() falls back to "2".
    await expect(
      resolveErc3009Domain(reader("9"), { chainId: 1480, token }),
    ).resolves.toEqual(domain);
    await expect(
      resolveErc3009Domain(reader(new Error("no version()")), {
        chainId: 1480,
        token,
      }),
    ).resolves.toEqual(domain);
    await expect(
      resolveErc3009Domain(reader("9"), { chainId: 14800, token }),
    ).rejects.toThrow(/DOMAIN_SEPARATOR/);
  });
});

describe("submitting to the gateway relayer", () => {
  const auth = {
    account: signer.address,
    from: signer.address,
    token,
    value: "1",
    validAfter: "0",
    validBefore: "1",
    salt,
    signature: `0x${"ab".repeat(65)}` as Hex,
  };
  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("returns the relayer tx on 202", async () => {
    const txHash = `0x${"cd".repeat(32)}`;
    const calls: string[] = [];
    const result = await submitDepositAuthorization(
      "https://dp-rpc.vana.org/",
      auth,
      (async (url: string, init: RequestInit) => {
        calls.push(url);
        expect(JSON.parse(init.body as string)).toEqual(auth);
        return new Response(JSON.stringify({ txHash, status: "submitted" }), {
          status: 202,
        });
      }) as typeof fetch,
    );
    expect(calls).toEqual([
      "https://dp-rpc.vana.org/v1/escrow/deposit-with-authorization",
    ]);
    expect(result).toEqual({ txHash, status: "submitted" });
  });

  it("keeps 409 (sign again) and 502 (resend) apart", async () => {
    const rejected = await submitDepositAuthorization(
      "https://gw",
      auth,
      answer(409, { error: "authorization is used" }),
    ).catch((e) => e);
    expect(rejected).toBeInstanceOf(DepositAuthorizationError);
    expect(rejected).toMatchObject({
      status: 409,
      rejected: true,
      transient: false,
    });
    expect(rejected.message).toBe("authorization is used");

    const transient = await submitDepositAuthorization(
      "https://gw",
      auth,
      answer(502, {}),
    ).catch((e) => e);
    expect(transient).toMatchObject({
      status: 502,
      rejected: false,
      transient: true,
    });
  });

  it("refuses a 202 without a transaction hash", async () => {
    await expect(
      submitDepositAuthorization("https://gw", auth, answer(202, {})),
    ).rejects.toThrow(/no transaction hash/);
  });
});

describe("waiting for the gateway to credit a relayed deposit", () => {
  const tx = `0x${"ef".repeat(32)}` as Hex;
  const sync = (states: string[]) => {
    let i = 0;
    return (async (url: string, init: RequestInit) => {
      expect(url).toBe(
        `https://gw/v1/escrow/balance/sync?account=${signer.address}`,
      );
      expect(init.method).toBe("POST");
      const state = states[Math.min(i++, states.length - 1)];
      const deposits: Record<string, { txHash: string }[]> = {
        submitted: [],
        finalized: [],
        failed: [],
      };
      if (state !== "none") deposits[state].push({ txHash: tx.toUpperCase() });
      return new Response(JSON.stringify({ data: { deposits } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  };
  const fast = { sleep: async () => {}, intervalMs: 0 };

  it("polls until the deposit is finalized", async () => {
    await expect(
      awaitDepositSettlement("https://gw", signer.address, tx, {
        ...fast,
        fetchImpl: sync(["submitted", "submitted", "finalized"]),
      }),
    ).resolves.toBe("finalized");
  });

  it("reports a failed deposit", async () => {
    await expect(
      awaitDepositSettlement("https://gw", signer.address, tx, {
        ...fast,
        fetchImpl: sync(["failed"]),
      }),
    ).resolves.toBe("failed");
  });

  it("gives up as pending at the deadline", async () => {
    let t = 0;
    await expect(
      awaitDepositSettlement("https://gw", signer.address, tx, {
        ...fast,
        timeoutMs: 10,
        now: () => (t += 5),
        fetchImpl: sync(["submitted"]),
      }),
    ).resolves.toBe("pending");
  });
});
