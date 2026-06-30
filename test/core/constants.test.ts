import { describe, it, expect } from "vitest";
import {
  getEnvConfig,
  ENV_CONFIG,
  DEFAULT_ENVIRONMENT,
} from "../../src/core/constants.js";

describe("getEnvConfig", () => {
  it("returns dev config for 'dev'", () => {
    const config = getEnvConfig("dev");
    expect(config).toBe(ENV_CONFIG.dev);
    expect(config.sessionRelayUrl).toContain("session-relay");
    expect(config.gatewayUrl).toBe("https://dp-rpc-dev.vana.org");
    expect(config.accountUrl).toBe("https://account-dev.vana.org");
  });

  it("returns prod config for 'prod'", () => {
    const config = getEnvConfig("prod");
    expect(config).toBe(ENV_CONFIG.prod);
    expect(config.gatewayUrl).toBe("https://dp-rpc.vana.org");
    expect(config.accountUrl).toBe("https://account.vana.org");
  });

  it("defaults to prod when no environment is specified", () => {
    const config = getEnvConfig();
    expect(config).toBe(ENV_CONFIG[DEFAULT_ENVIRONMENT]);
    expect(config).toBe(ENV_CONFIG.prod);
  });
});
