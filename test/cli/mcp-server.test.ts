import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer, showData } from "../../src/cli/mcp-server.js";
import type { DataShowQueryResult } from "../../src/cli/queries.js";

// A synthetic GitHub result far larger than one tool result should carry.
const githubData = {
  exportSummary: {
    count: 2,
    label: "items",
    details: { repositories: 600, starred: 1, events: 300 },
  },
  "github.profile": { login: "octo", name: "Octo Cat" },
  "github.repositories": {
    repositories: Array.from({ length: 600 }, (_, i) => ({
      name: i === 7 ? "vector-search" : `repo-${i}`,
      description: "d".repeat(1_000),
    })),
  },
  "github.starred": { starred: [{ name: "vana-cli" }] },
};

function fakeQuery(data: Record<string, unknown> | null) {
  return async (source: string): Promise<DataShowQueryResult> =>
    data
      ? {
          ok: true,
          source,
          name: "GitHub",
          path: "/synthetic/github.json",
          summary: { lines: ["Repositories: 600"] },
          lastRunAt: "2026-10-01T00:00:00.000Z",
          dataState: "collected_local",
          nextSteps: [],
          data,
          datasetCount: 1,
        }
      : {
          ok: false,
          error: "dataset_not_found",
          source,
          message: `No collected dataset found for ${source}.`,
          nextSteps: [`Run \`vana connect ${source}\` to collect data.`],
          datasetCount: 0,
        };
}

async function connect(data: Record<string, unknown> | null) {
  const server = createMcpServer({ queryDataShow: fakeQuery(data) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

describe("vana mcp tools", () => {
  it("does not list generate_context while it is unimplemented", async () => {
    const client = await connect(githubData);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("generate_context");
    expect(names).toEqual(
      expect.arrayContaining([
        "check_status",
        "list_sources",
        "show_data",
        "connect_source",
        "run_diagnostics",
      ]),
    );
    const showData = tools.find((tool) => tool.name === "show_data");
    expect(Object.keys(showData?.inputSchema.properties ?? {})).toEqual([
      "source",
      "scope",
      "offset",
      "limit",
      "query",
    ]);
    expect(showData?.inputSchema.required).toEqual(["source"]);
  });

  it("show_data without scope returns an overview, never the dataset", async () => {
    const client = await connect(githubData);
    const result = await client.callTool({
      name: "show_data",
      arguments: { source: "github" },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(5_000);
    expect(text).not.toContain("repo-1");
    const parsed = JSON.parse(text);
    expect(parsed.scopes).toEqual([
      expect.objectContaining({ scope: "github.profile", kind: "record" }),
      expect.objectContaining({
        scope: "github.repositories",
        kind: "list",
        items: 600,
      }),
      expect.objectContaining({ scope: "github.starred", items: 1 }),
    ]);
    expect(parsed.exportSummary.details.events).toBe(300);
    expect(parsed.howToRead).toContain('scope "github.repositories"');
  });

  it("show_data with scope pages through items under the size cap", async () => {
    const client = await connect(githubData);
    const result = await client.callTool({
      name: "show_data",
      arguments: {
        source: "github",
        scope: "repositories",
        offset: 0,
        limit: 500,
      },
    });
    const text = textOf(result);
    expect(text.length).toBeLessThan(120_000);
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(600);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextOffset).toBe(parsed.returned);
  });

  it("show_data filters with query", async () => {
    const client = await connect(githubData);
    const parsed = JSON.parse(
      textOf(
        await client.callTool({
          name: "show_data",
          arguments: {
            source: "github",
            scope: "repositories",
            query: "VECTOR",
          },
        }),
      ),
    );
    expect(parsed.matched).toBe(1);
    expect(parsed.items[0].name).toBe("vector-search");
  });

  it("reports unknown scopes and missing datasets as errors", async () => {
    const client = await connect(githubData);
    const unknown = await client.callTool({
      name: "show_data",
      arguments: { source: "github", scope: "gists" },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(textOf(unknown)).availableScopes).toContain(
      "github.repositories",
    );

    const missing = await showData(
      { source: "spotify" },
      { queryDataShow: fakeQuery(null) },
    );
    expect(missing).toMatchObject({ ok: false, error: "dataset_not_found" });
  });
});
