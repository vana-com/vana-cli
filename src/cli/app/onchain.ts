/**
 * `vana app onchain <scope> --owner <address>` - the on-chain trace of a
 * data point: id, version, hashes, when it landed, whether it was deleted.
 */

import {
  DataPointDeletedError,
  createGatewayClient,
  deriveDataPointId,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import { isAddress, type Address } from "viem";
import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";

export interface OnchainCommandOptions extends AppCommandOptions {
  owner?: string;
}

export interface OnchainDeps {
  createClient?: (gatewayUrl: string) => GatewayClient;
}

export async function runAppOnchain(
  scope: string,
  options: OnchainCommandOptions,
  deps: OnchainDeps = {},
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

  if (!options.owner || !isAddress(options.owner)) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message:
        "An --owner address is required (the data point id derives from owner + scope).",
      remedy: `vana app onchain ${scope} --owner 0x...`,
      network: network.name,
    });
  }

  const dataPointId = deriveDataPointId(options.owner as Address, scope);
  const client = (deps.createClient ?? createGatewayClient)(network.gatewayUrl);

  try {
    const record = await client.getDataPoint(dataPointId, {
      includeDeleted: true,
    });
    if (!record) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "scope_not_found",
        message: `No data point for ${scope} under ${options.owner} on ${network.name}.`,
        network: network.name,
        data: { dataPointId },
      });
    }
    return emitAppOutcome(options, {
      status: "done",
      code: "ok",
      message: record.deletedAt
        ? `Data point exists but was deleted at ${record.deletedAt}.`
        : `Version ${record.expectedVersion}, registered ${record.addedAt}.`,
      network: network.name,
      data: {
        dataPointId,
        owner: record.ownerAddress,
        scope: record.scope,
        version: record.expectedVersion,
        dataHash: record.dataHash,
        addedAt: record.addedAt,
        deletedAt: record.deletedAt ?? null,
      },
    });
  } catch (error) {
    if (error instanceof DataPointDeletedError) {
      return emitAppOutcome(options, {
        status: "done",
        code: "ok",
        message: "Data point exists but was deleted (tombstoned).",
        network: network.name,
        data: { dataPointId, deleted: true },
      });
    }
    return emitAppOutcome(options, {
      status: "failed",
      code: "gateway_unreachable",
      message: `Data point lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      network: network.name,
    });
  }
}
