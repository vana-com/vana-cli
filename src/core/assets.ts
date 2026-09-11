/**
 * Fee asset metadata.
 *
 * Protocol fees are quoted in base units of an asset that is not always the
 * native coin: a `data_access` fee on mainnet is denominated in USDC.e,
 * which has 6 decimals, so formatting every amount as 18-decimal VANA is
 * wrong by twelve orders of magnitude and mislabels the currency. Worse,
 * comparing a `--max-fee` parsed as ether against a 6-decimal amount
 * silently disables the guard.
 */

import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import type { Address } from "viem";

/** Zero address in a fee quote means the chain's native coin. */
export const NATIVE_ASSET = "0x0000000000000000000000000000000000000000";

export interface AssetInfo {
  address: string;
  symbol: string;
  decimals: number;
}

const NATIVE: AssetInfo = {
  address: NATIVE_ASSET,
  symbol: "VANA",
  decimals: 18,
};

const cache = new Map<string, AssetInfo>();

function isNative(asset: string | undefined): boolean {
  return !asset || asset.toLowerCase() === NATIVE_ASSET;
}

/**
 * Resolve an asset's symbol and decimals, reading the ERC20 on chain once
 * per process. Unknown assets fall back to raw base units rather than
 * guessing 18 decimals, so a wrong number is never shown as if it were
 * right.
 */
export async function resolveAsset(
  asset: string | undefined,
  rpcUrl: string,
): Promise<AssetInfo | null> {
  if (isNative(asset)) {
    return NATIVE;
  }
  const key = (asset as string).toLowerCase();
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address: asset as Address,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      client.readContract({
        address: asset as Address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);
    const info: AssetInfo = {
      address: asset as string,
      symbol: String(symbol),
      decimals: Number(decimals),
    };
    cache.set(key, info);
    return info;
  } catch {
    return null;
  }
}

/** Human amount for display: "0.01 USDC.e", or base units when unknown. */
export function formatAssetAmount(
  amount: string,
  info: AssetInfo | null,
): string {
  if (!info) {
    return `${amount} base units`;
  }
  return `${formatUnits(BigInt(amount), info.decimals)} ${info.symbol}`;
}

/**
 * Parse a user-supplied decimal limit into base units of the asset.
 * Returns null when the asset is unknown, so callers refuse to compare
 * rather than compare wrongly.
 */
export function parseAssetAmount(
  value: string,
  info: AssetInfo | null,
): bigint | null {
  if (!info) {
    return null;
  }
  try {
    return parseUnits(value, info.decimals);
  } catch {
    return null;
  }
}
