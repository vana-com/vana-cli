/**
 * `vana app escrow balance|fund` - what the app can spend, and funding it.
 *
 * Funding is deliberately one command for both halves: the on-chain
 * `depositNative(account)` transaction and the gateway deposit
 * registration. Either half alone produces a contract that looks funded
 * while every read still answers 402.
 */

import {
  CONTRACTS,
  createGatewayClient,
  encodeDepositNativeData,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import { getChainConfig } from "@opendatalabs/vana-sdk/chains";
import type { Chain } from "viem";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
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
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface EscrowFundOptions extends AppCommandOptions {
  /** Amount to deposit, in VANA (decimal string). */
  amount?: string;
}

export interface EscrowDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
  resolveKey?: typeof resolveAppKey;
  /** Injectable chain senders for tests. */
  sendDeposit?: (params: {
    network: ResolvedNetwork;
    key: ResolvedAppKey;
    escrowContract: `0x${string}`;
    amountWei: bigint;
  }) => Promise<{ txHash: `0x${string}` }>;
}

function resolveContext(
  options: AppCommandOptions,
  deps: EscrowDeps,
):
  | { ok: true; network: ResolvedNetwork; key: ResolvedAppKey }
  | { ok: false; exitCode: number } {
  let network: ResolvedNetwork;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      return {
        ok: false,
        exitCode: emitAppOutcome(options, {
          status: "failed",
          code: "bad_usage",
          message: error.message,
        }),
      };
    }
    throw error;
  }
  try {
    const key = (deps.resolveKey ?? resolveAppKey)({});
    return { ok: true, network, key };
  } catch (error) {
    if (error instanceof AppKeyMissingError) {
      return {
        ok: false,
        exitCode: emitAppOutcome(options, {
          status: "failed",
          code: "bad_usage",
          message: "No app key on this machine yet.",
          remedy: "vana app register",
          network: network.name,
        }),
      };
    }
    throw error;
  }
}

export async function runAppEscrowBalance(
  options: AppCommandOptions,
  deps: EscrowDeps = {},
): Promise<number> {
  const context = resolveContext(options, deps);
  if (!context.ok) {
    return context.exitCode;
  }
  const { network, key } = context;
  const client = (deps.createClient ?? createGatewayClient)(network.gatewayUrl);
  try {
    const balance = await client.getEscrowBalance(key.address);
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message:
        balance.balances.length === 0
          ? "Escrow is empty."
          : balance.balances
              .map(
                (entry) =>
                  `${formatEther(BigInt(entry.availableAmount ?? "0"))} VANA available`,
              )
              .join(", "),
      network: network.name,
      data: {
        address: key.address,
        balances: balance.balances,
        deposits: {
          submitted: balance.deposits.submitted.length,
          finalized: balance.deposits.finalized.length,
          failed: balance.deposits.failed.length,
        },
      },
    });
  } catch (error) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "gateway_unreachable",
      message: `Escrow balance lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      network: network.name,
    });
  }
}

async function defaultSendDeposit(params: {
  network: ResolvedNetwork;
  key: ResolvedAppKey;
  escrowContract: `0x${string}`;
  amountWei: bigint;
}): Promise<{ txHash: `0x${string}` }> {
  const chain = getChainConfig(params.network.chainId) as unknown as Chain;
  const account = privateKeyToAccount(params.key.privateKey);
  const transport = http(params.network.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const balance = await publicClient.getBalance({
    address: params.key.address,
  });
  if (balance < params.amountWei) {
    throw new InsufficientFundsError(balance, params.amountWei);
  }

  const walletClient = createWalletClient({ account, chain, transport });
  const txHash = await walletClient.sendTransaction({
    to: params.escrowContract,
    data: encodeDepositNativeData({ account: params.key.address }),
    value: params.amountWei,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash };
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly neededWei: bigint,
  ) {
    super(
      `Wallet holds ${formatEther(balanceWei)} VANA, needs ${formatEther(neededWei)} plus gas`,
    );
    this.name = "InsufficientFundsError";
  }
}

export async function runAppEscrowFund(
  options: EscrowFundOptions,
  deps: EscrowDeps = {},
): Promise<number> {
  const context = resolveContext(options, deps);
  if (!context.ok) {
    return context.exitCode;
  }
  const { network, key } = context;

  let amountWei: bigint;
  try {
    amountWei = parseEther(options.amount ?? "");
    if (amountWei <= 0n) {
      throw new Error("not positive");
    }
  } catch {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: "A positive --amount in VANA is required.",
      remedy: "vana app escrow fund --amount 0.5",
      network: network.name,
    });
  }

  if (network.name === "mainnet" && !options.yes) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "confirmation_required",
      message: `This deposits ${options.amount} real VANA on mainnet.`,
      remedy: `re-run with --yes to confirm`,
      network: network.name,
    });
  }

  const escrowContract = (
    CONTRACTS.DataPortabilityEscrow.addresses as Record<number, `0x${string}`>
  )[network.chainId];
  if (!escrowContract) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "internal",
      message: `No escrow contract known for chain ${network.chainId}.`,
      network: network.name,
    });
  }

  let txHash: `0x${string}`;
  try {
    ({ txHash } = await (deps.sendDeposit ?? defaultSendDeposit)({
      network,
      key,
      escrowContract,
      amountWei,
    }));
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "payment_required",
        message: error.message,
        remedy:
          network.name === "moksha"
            ? "fund the app wallet from the Moksha faucet: https://faucet.vana.org"
            : `send VANA to ${key.address}`,
        network: network.name,
        data: { address: key.address },
      });
    }
    return emitAppOutcome(options, {
      status: "failed",
      code: "internal",
      message: `On-chain deposit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      network: network.name,
    });
  }

  // Second half: tell the gateway about the deposit. Idempotent to re-run;
  // a crash between halves is recoverable by re-running fund (the on-chain
  // half will fail on balance, but submit can be redone via the txHash we
  // print).
  const client = (deps.createClient ?? createGatewayClient)(network.gatewayUrl);
  try {
    const state = await client.submitEscrowDeposit({ txHash });
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: `Deposited ${options.amount} VANA into escrow.`,
      network: network.name,
      data: {
        txHash,
        gatewayStatus: state.status,
        explorer: `${network.explorerUrl}/tx/${txHash}`,
      },
    });
  } catch (error) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "gateway_unreachable",
      message: `On-chain deposit ${txHash} confirmed, but the gateway registration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      remedy: `re-run: the deposit is on chain, only the gateway half is missing (tx ${txHash})`,
      network: network.name,
      data: { txHash },
    });
  }
}
