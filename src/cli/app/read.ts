/**
 * `vana app read <scope> --grant <id>` - signed read of granted data,
 * settling the fee from escrow when `--pay` allows it.
 *
 * Flow: resolve the grant at the gateway (grantor = owner), resolve the
 * owner's Personal Server registrations (every active one - registrations
 * are push-only and a record can name a dead server), then read. A stored
 * receipt for this (network, grant, scope) is replayed before any new
 * settlement, so a retry never pays twice; a new settlement is gated by
 * `--pay` and `--max-fee` and its X-PAYMENT header is captured into the
 * receipts store.
 *
 * The enclave delivery leg lands when the jobs result-delivery change ships
 * in the SDK (vana-sdk#211); today every owner readable here serves through
 * a Personal Server.
 */

import {
  CONTRACTS,
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import {
  readPersonalServerData,
  type PersonalServerFetch,
} from "@opendatalabs/vana-sdk/direct/personal-server-read";
import { formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AppKeyMissingError,
  resolveAppKey,
  type ResolvedAppKey,
} from "../../core/app-key.js";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import {
  createReceiptsStore,
  receiptKey,
  type ReceiptsStore,
} from "../../core/receipts.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface ReadCommandOptions extends AppCommandOptions {
  grant?: string;
  /** Settle a 402 from escrow instead of stopping at exit 4. */
  pay?: boolean;
  /** Refuse settlements above this amount, in VANA (decimal). */
  maxFee?: string;
  /** Explicit Personal Server URL, skipping gateway resolution. */
  server?: string;
}

export interface ReadDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  resolveKey?: typeof resolveAppKey;
  read?: typeof readPersonalServerData;
  receipts?: ReceiptsStore;
}

function isPaymentRequired(error: unknown): error is Error & {
  details?: { amount?: string; asset?: string };
} {
  return error instanceof Error && error.name === "PaymentRequiredError";
}

export async function runAppRead(
  scope: string,
  options: ReadCommandOptions,
  deps: ReadDeps = {},
): Promise<number> {
  let network: ResolvedNetwork;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: error.message,
      });
    }
    throw error;
  }

  if (!options.grant) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: "A grant id is required.",
      remedy: `vana app read ${scope} --grant <id>`,
      network: network.name,
    });
  }

  let key: ResolvedAppKey;
  try {
    key = (deps.resolveKey ?? resolveAppKey)({});
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "grant_invalid",
        message: "No app key on this machine; a grant cannot belong to it.",
        remedy: "vana app register",
        network: network.name,
      });
    }
    throw error;
  }

  const client = (deps.createClient ?? createGatewayClient)(network.gatewayUrl);

  // 1. The grant: existence, scope coverage, and the owner behind it.
  let grantorAddress: string;
  try {
    const grant = await client.getGrant(options.grant);
    if (!grant) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "grant_invalid",
        message: `Grant ${options.grant} does not exist on ${network.name}.`,
        network: network.name,
      });
    }
    if (!grant.scopes.includes(scope)) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "grant_invalid",
        message: `The grant does not cover ${scope}.`,
        remedy: `granted scopes: ${grant.scopes.join(", ")}`,
        network: network.name,
      });
    }
    grantorAddress = grant.grantorAddress;
  } catch (error) {
    return gatewayFailure(options, network, error, "grant lookup");
  }

  // 2. The owner's servers: every active registration, newest first.
  let serverUrls: string[];
  if (options.server) {
    serverUrls = [options.server];
  } else {
    try {
      const servers = await client.listServersByOwner(grantorAddress);
      serverUrls = servers.active.map((record) => record.serverUrl);
    } catch (error) {
      return gatewayFailure(options, network, error, "server resolution");
    }
    if (serverUrls.length === 0) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "owner_not_ready",
        message: `The owner ${grantorAddress} has no registered Personal Server.`,
        network: network.name,
      });
    }
  }

  const account = privateKeyToAccount(key.privateKey);
  const signMessage = (message: string) => account.signMessage({ message });
  const receipts = deps.receipts ?? createReceiptsStore();
  const storedKey = receiptKey(network.name, options.grant, scope);
  const stored = receipts.getReceipt(storedKey);
  const read = deps.read ?? readPersonalServerData;
  const escrowContract = (
    CONTRACTS.DataPortabilityEscrow.addresses as Record<number, `0x${string}`>
  )[network.chainId];

  // Replays the stored receipt header; captures any new X-PAYMENT header.
  let sentPaymentHeader: string | null = null;
  const fetchWith = (replayHeader: string | null): PersonalServerFetch => {
    return async (input, init) => {
      const headers = { ...init.headers };
      if (replayHeader && !headers["X-PAYMENT"]) {
        headers["X-PAYMENT"] = replayHeader;
      }
      if (headers["X-PAYMENT"]) {
        sentPaymentHeader = headers["X-PAYMENT"];
      }
      return fetch(input, { ...init, headers });
    };
  };

  let lastError: unknown = null;
  for (const personalServerUrl of serverUrls) {
    // Probe (free): signed read, replaying a stored receipt when we have one.
    try {
      const result = await read({
        personalServerUrl,
        scope,
        grantId: options.grant,
        payerAddress: key.address,
        signMessage,
        fetchFn: fetchWith(stored?.header ?? null),
      });
      return emitReadSuccess(options, network, scope, result.data, {
        paid: false,
        replayedReceipt: Boolean(stored),
        server: personalServerUrl,
        payment: result.payment,
      });
    } catch (error) {
      if (!isPaymentRequired(error)) {
        // Transport or server failure: a dead registration is a normal
        // state, try the next one.
        lastError = error;
        continue;
      }
      // A 402 with a stale stored receipt means the receipt no longer
      // satisfies the server; drop it so it cannot shadow a real payment.
      if (stored) {
        receipts.dropReceipt(storedKey);
      }
      const details =
        (error as { details?: { amount?: string; asset?: string } }).details ??
        {};
      const amountRaw = details.amount ?? "0";
      const amountVana = formatEther(BigInt(amountRaw));

      if (!options.pay) {
        return emitAppOutcome(options, {
          status: "failed",
          code: "payment_required",
          message: `This read costs ${amountVana} VANA and --pay is not set.`,
          remedy: `vana app read ${scope} --grant ${options.grant} --pay`,
          network: network.name,
          data: { amount: amountRaw, amountVana, asset: details.asset },
        });
      }
      if (options.maxFee && BigInt(amountRaw) > parseEther(options.maxFee)) {
        return emitAppOutcome(options, {
          status: "failed",
          code: "max_fee_exceeded",
          message: `This read costs ${amountVana} VANA, above --max-fee ${options.maxFee}.`,
          network: network.name,
          data: { amount: amountRaw, amountVana, asset: details.asset },
        });
      }
      if (!escrowContract) {
        return emitAppOutcome(options, {
          status: "failed",
          code: "internal",
          message: `No escrow contract known for chain ${network.chainId}.`,
          network: network.name,
        });
      }

      // Paid attempt: sign a fresh header (durable nonce), capture it.
      try {
        const result = await read({
          personalServerUrl,
          scope,
          grantId: options.grant,
          payerAddress: key.address,
          signMessage,
          escrow: {
            escrowContract,
            chainId: network.chainId,
            signTypedData: (typedData) =>
              account.signTypedData(
                typedData as Parameters<typeof account.signTypedData>[0],
              ),
            nonceSource: (payer) => receipts.nextNonce(payer),
          },
          fetchFn: fetchWith(null),
        });
        if (sentPaymentHeader) {
          receipts.saveReceipt(storedKey, {
            header: sentPaymentHeader,
            amount: amountRaw,
            asset: details.asset ?? "",
            capturedAt: new Date().toISOString(),
            payment: result.payment as Record<string, unknown> | undefined,
          });
        }
        return emitReadSuccess(options, network, scope, result.data, {
          paid: true,
          amount: amountRaw,
          amountVana,
          server: personalServerUrl,
          payment: result.payment,
        });
      } catch (paidError) {
        // The fee may already be settled: report it instead of inviting a
        // blind retry that pays again.
        const spent = sentPaymentHeader ? amountRaw : null;
        return emitAppOutcome(options, {
          status: "failed",
          code: isPaymentRequired(paidError)
            ? "payment_required"
            : "server_unavailable",
          message: `Read failed after payment was attempted: ${
            paidError instanceof Error ? paidError.message : String(paidError)
          }`,
          remedy:
            "the signed payment header is stored; re-running replays it without paying again",
          network: network.name,
          data: { spentFee: spent, server: personalServerUrl },
        });
      }
    }
  }

  return emitAppOutcome(options, {
    status: "failed",
    code: "server_unavailable",
    message: `No server holding this data answered (${serverUrls.length} registration${serverUrls.length === 1 ? "" : "s"} tried).`,
    remedy: lastError instanceof Error ? lastError.message : "retry later",
    network: network.name,
    data: { serversTried: serverUrls.length },
  });
}

function gatewayFailure(
  options: AppCommandOptions,
  network: ResolvedNetwork,
  error: unknown,
  stage: string,
): number {
  return emitAppOutcome(options, {
    status: "failed",
    code: "gateway_unreachable",
    message: `Gateway ${stage} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    remedy: "check connectivity to " + network.gatewayUrl + " and retry",
    network: network.name,
  });
}

function emitReadSuccess(
  options: ReadCommandOptions,
  network: ResolvedNetwork,
  scope: string,
  data: unknown,
  meta: Record<string, unknown>,
): number {
  if (options.json) {
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: `Read ${scope}.`,
      network: network.name,
      data: { ...meta, result: data },
    });
  }
  // Human mode: the payload alone on stdout (pipeable), the summary on
  // stderr so `vana app read ... | jq` stays clean.
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  if (!options.quiet) {
    const paidNote = meta.paid
      ? ` (paid ${String(meta.amountVana)} VANA)`
      : meta.replayedReceipt
        ? " (existing receipt replayed, nothing new paid)"
        : "";
    process.stderr.write(
      `Read ${scope}${paidNote} from ${String(meta.server)}\n`,
    );
  }
  return 0;
}
