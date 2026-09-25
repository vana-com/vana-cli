import { describe, expect, it } from "vitest";

import { checkRegisteredServers } from "../../src/personal-server/registered.js";

const OWNER = "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d";
const server = (url: string, serverAddress: string) => ({
  network: "mainnet" as const,
  url,
  serverAddress,
  status: "active",
});

describe("checkRegisteredServers", () => {
  it("counts only a server that answers as this owner's registered server", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith("https://live")) {
        return new Response(
          JSON.stringify({
            owner: OWNER.toLowerCase(),
            identity: { address: "0xAAA" },
          }),
        );
      }
      if (target.startsWith("https://stranger")) {
        return new Response(
          JSON.stringify({
            owner: "0x0000000000000000000000000000000000000001",
          }),
        );
      }
      if (target.startsWith("https://rekeyed")) {
        return new Response(
          JSON.stringify({ owner: OWNER, identity: { address: "0xCCC" } }),
        );
      }
      if (target.startsWith("https://gone")) {
        return new Response(
          JSON.stringify({
            error: "not_found",
            message: "No tunnel is currently active",
          }),
          { status: 404 },
        );
      }
      throw new Error("no answer");
    }) as typeof fetch;

    const checked = await checkRegisteredServers(
      [
        server("https://live.example", "0xaaa"),
        server("https://stranger.example", "0xbbb"),
        server("https://rekeyed.example", "0xddd"),
        server("https://gone.example", "0xeee"),
        server("https://silent.example", "0xfff"),
      ],
      OWNER,
      fetchImpl,
    );
    expect(checked.map((entry) => [entry.url, entry.reachable])).toEqual([
      ["https://live.example", true],
      ["https://stranger.example", false],
      ["https://rekeyed.example", false],
      ["https://gone.example", false],
      ["https://silent.example", false],
    ]);
  });
});
