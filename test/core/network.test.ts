import { describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK,
  UnknownNetworkError,
  isVanaNetworkName,
  resolveNetwork,
} from "../../src/core/network.js";

describe("resolveNetwork", () => {
  it("defaults to moksha with prod hosts", () => {
    const network = resolveNetwork(undefined, {});
    expect(network.name).toBe("moksha");
    expect(network.name).toBe(DEFAULT_NETWORK);
    expect(network.env).toBe("prod");
    expect(network.chainId).toBe(14800);
    expect(network.gatewayUrl).toBe("https://dp-rpc.moksha.vana.org");
  });

  it("resolves mainnet", () => {
    const network = resolveNetwork("mainnet", {});
    expect(network.chainId).toBe(1480);
    expect(network.gatewayUrl).toBe("https://dp-rpc.vana.org");
    expect(network.explorerUrl).toBe("https://vanascan.io");
  });

  it("reads VANA_NETWORK when no flag is given", () => {
    const network = resolveNetwork(undefined, { VANA_NETWORK: "mainnet" });
    expect(network.name).toBe("mainnet");
  });

  it("prefers the explicit name over VANA_NETWORK", () => {
    const network = resolveNetwork("moksha", { VANA_NETWORK: "mainnet" });
    expect(network.name).toBe("moksha");
  });

  it("is case-insensitive", () => {
    expect(resolveNetwork("Mainnet", {}).name).toBe("mainnet");
  });

  it("swaps in dev hosts under VANA_ENV=dev", () => {
    const network = resolveNetwork("moksha", { VANA_ENV: "dev" });
    expect(network.env).toBe("dev");
    expect(network.chainId).toBe(14800);
    expect(network.gatewayUrl).toBe("https://dp-rpc-dev.vana.org");
    expect(network.accountUrl).toBe("https://account-dev.vana.org");
    // Explorer and rpc stay on the chain, not the deployment.
    expect(network.explorerUrl).toBe("https://moksha.vanascan.io");
  });

  it("refuses mainnet with dev hosts", () => {
    expect(() => resolveNetwork("mainnet", { VANA_ENV: "dev" })).toThrow(
      UnknownNetworkError,
    );
  });

  it("throws UnknownNetworkError for anything else", () => {
    expect(() => resolveNetwork("goerli", {})).toThrow(UnknownNetworkError);
    expect(() => resolveNetwork(undefined, { VANA_NETWORK: "nope" })).toThrow(
      UnknownNetworkError,
    );
  });
});

describe("isVanaNetworkName", () => {
  it("accepts the two networks and nothing else", () => {
    expect(isVanaNetworkName("moksha")).toBe(true);
    expect(isVanaNetworkName("mainnet")).toBe(true);
    expect(isVanaNetworkName("dev")).toBe(false);
    expect(isVanaNetworkName("")).toBe(false);
  });
});
