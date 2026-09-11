import { describe, expect, it } from "vitest";
import {
  NATIVE_ASSET,
  formatAssetAmount,
  parseAssetAmount,
  resolveAsset,
  type AssetInfo,
} from "../../src/core/assets.js";

/** The asset a mainnet data_access fee is actually quoted in. */
const USDC: AssetInfo = {
  address: "0xF1815bd50389c46847f0Bda824eC8da914045D14",
  symbol: "USDC.e",
  decimals: 6,
};
const VANA: AssetInfo = {
  address: NATIVE_ASSET,
  symbol: "VANA",
  decimals: 18,
};

describe("formatAssetAmount", () => {
  it("formats a 6-decimal token fee as itself, not as ether", () => {
    // A live mainnet read quoted 10000 base units. Read as ether that is
    // 0.00000000000001 "VANA"; read correctly it is one cent of USDC.e.
    expect(formatAssetAmount("10000", USDC)).toBe("0.01 USDC.e");
    expect(formatAssetAmount("10000", VANA)).toBe("0.00000000000001 VANA");
  });

  it("falls back to base units when the asset is unknown", () => {
    expect(formatAssetAmount("10000", null)).toBe("10000 base units");
  });
});

describe("parseAssetAmount", () => {
  it("parses a limit in the asset's own decimals", () => {
    expect(parseAssetAmount("0.005", USDC)).toBe(5000n);
    expect(parseAssetAmount("0.01", USDC)).toBe(10000n);
    expect(parseAssetAmount("1", VANA)).toBe(10n ** 18n);
  });

  it("makes the --max-fee comparison meaningful for tokens", () => {
    const fee = 10000n; // 0.01 USDC.e
    // Parsed as ether, a 0.005 limit would be 5e15 and the fee would pass,
    // silently disabling the guard. In the asset's decimals it is caught.
    expect(fee > (parseAssetAmount("0.005", USDC) as bigint)).toBe(true);
    expect(fee > (parseAssetAmount("0.02", USDC) as bigint)).toBe(false);
  });

  it("returns null for an unknown asset so callers refuse to compare", () => {
    expect(parseAssetAmount("0.005", null)).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseAssetAmount("not-a-number", USDC)).toBeNull();
  });
});

describe("resolveAsset", () => {
  it("resolves the native asset without touching the network", async () => {
    // An unreachable RPC proves no call is made for the zero address.
    const info = await resolveAsset(NATIVE_ASSET, "http://127.0.0.1:1");
    expect(info).toEqual(VANA);
    expect(await resolveAsset(undefined, "http://127.0.0.1:1")).toEqual(VANA);
  });

  it("returns null when a token cannot be read", async () => {
    expect(await resolveAsset(USDC.address, "http://127.0.0.1:1")).toBeNull();
  });
});
