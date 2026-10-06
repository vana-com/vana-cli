/**
 * MCP (Model Context Protocol) server for agent integration.
 *
 * Exposes high-level tools over stdio so any MCP-compatible agent
 * (Claude Code, Cursor, etc.) can discover and call them.
 *
 * CRITICAL: All logging/output goes to stderr. stdout is the JSON-RPC transport.
 */

import { spawn } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCliVersion } from "./index.js";
import {
  queryStatus,
  querySources,
  queryDataShow,
  queryDoctor,
} from "./queries.js";
import {
  DEFAULT_SLICE_LIMIT,
  DEFAULT_SLICE_MAX_BYTES,
  MAX_SLICE_LIMIT,
  UnknownScopeError,
  describeScopes,
  sliceScope,
  type DataSlice,
  type ScopeOverview,
} from "./data-slice.js";

export interface McpServerDeps {
  queryDataShow?: typeof queryDataShow;
}

/** Build the MCP server with every tool registered, not yet connected. */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const version = getCliVersion();

  const server = new McpServer({
    name: "vana",
    version,
  });

  // ── Tool: check_status ───────────────────────────────────────────────

  server.tool(
    "check_status",
    "Check system health: runtime state, Personal Server connection, and connected source status",
    async () => {
      const result = await queryStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Tool: list_sources ───────────────────────────────────────────────

  server.tool(
    "list_sources",
    "List available data sources that can be connected for personal data collection",
    { filter: z.string().optional().describe("Filter sources by name") },
    async ({ filter }) => {
      const result = await querySources();
      if (filter) {
        const lowerFilter = filter.toLowerCase();
        result.sources = result.sources.filter(
          (s) =>
            s.id.toLowerCase().includes(lowerFilter) ||
            s.name.toLowerCase().includes(lowerFilter),
        );
        result.count = result.sources.length;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Tool: show_data ──────────────────────────────────────────────────

  server.tool(
    "show_data",
    [
      "Inspect or read collected data for a connected source.",
      "Without `scope` it returns an overview: summary, sync state, file path, and every scope with its item count and size in bytes (no data).",
      `With \`scope\` it returns one page of that scope's items: \`offset\` (default 0) and \`limit\` (default ${DEFAULT_SLICE_LIMIT}, max ${MAX_SLICE_LIMIT}) page through them, \`query\` keeps only items whose JSON contains the text (case-insensitive).`,
      `A page never exceeds about ${Math.round(DEFAULT_SLICE_MAX_BYTES / 1000)} KB; when more remain the result gives \`nextOffset\` to pass next.`,
    ].join(" "),
    {
      source: z.string().describe("Source identifier (e.g. github, chatgpt)"),
      scope: z
        .string()
        .optional()
        .describe(
          "Scope to read, as listed in the overview (e.g. github.repositories, or just repositories). Omit for the overview.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Index of the first item to return (default 0)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SLICE_LIMIT)
        .optional()
        .describe(
          `Maximum items to return (default ${DEFAULT_SLICE_LIMIT}); the size cap may return fewer`,
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Case-insensitive text filter: keep only items whose JSON contains it",
        ),
    },
    async (args) => {
      const result = await showData(args, deps);
      // A page is sized against compact JSON; indenting it would push it
      // past the cap.
      const text = args.scope
        ? JSON.stringify(result)
        : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  // ── Tool: connect_source ─────────────────────────────────────────────

  server.tool(
    "connect_source",
    "Connect a platform and collect personal data. Runs the full connect flow: setup, authentication, data collection, and sync",
    { source: z.string().describe("Source identifier (e.g. github, twitter)") },
    async ({ source }) => {
      // Check auth mode before spawning — legacy sources need a headed
      // browser and cannot be connected by an agent.
      const sourcesResult = await querySources();
      const sourceInfo = sourcesResult.sources?.find(
        (s) =>
          s.id === source || s.name?.toLowerCase() === source.toLowerCase(),
      );

      if (sourceInfo?.authMode === "legacy") {
        return {
          content: [
            {
              type: "text" as const,
              text: `${sourceInfo.name ?? source} requires browser login. The user must run this in their own terminal:\n\nvana connect ${source}\n\nThis source cannot be connected by an agent.`,
            },
          ],
        };
      }

      return await runConnectAsChild(source);
    },
  );

  // ── Tool: run_diagnostics ────────────────────────────────────────────

  server.tool(
    "run_diagnostics",
    "Run detailed system diagnostics: CLI version, runtime paths, browser state, connector cache, and source-level issues",
    async () => {
      const result = await queryDoctor();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // generate_context is not registered until it does something: a listed
  // tool that only answers "not yet implemented" wastes an agent's call.

  return server;
}

/**
 * Start the MCP server on stdio.
 *
 * Returns a promise that resolves when the transport disconnects.
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();

  // ── Connect transport and run ────────────────────────────────────────

  // A human running `vana mcp` in a terminal sees a silent hang, because
  // this is an stdio JSON-RPC server meant to be launched by an MCP client.
  // Say so on stderr (stdout is the transport and must stay clean).
  if (process.stdin.isTTY) {
    process.stderr.write(
      [
        "vana mcp is an MCP server speaking JSON-RPC over stdio.",
        "It is meant to be launched by an MCP client, not run by hand:",
        "  claude mcp add vana -- vana mcp",
        "Waiting for a client on stdin (Ctrl-C or Ctrl-D to exit)...",
        "",
      ].join("\n"),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Wait until the transport closes.
  //
  // StdioServerTransport only fires onclose when close() is invoked
  // programmatically — it never watches stdin for "end" — so a client
  // disconnect would leave this promise unsettled and the process would die
  // with an "unsettled top-level await" warning (exit 13) instead of
  // exiting cleanly. Resolve on stdin EOF as well.
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.off("end", onStdinEnd);
      resolve();
    };
    const onStdinEnd = (): void => done();
    process.stdin.once("end", onStdinEnd);
    transport.onclose = () => done();
  });
}

// ── show_data ────────────────────────────────────────────────────────

export interface ShowDataArgs {
  source: string;
  scope?: string;
  offset?: number;
  limit?: number;
  query?: string;
}

export type ShowDataResult =
  | {
      ok: true;
      source: string;
      name: string;
      path: string;
      lastRunAt: string | null;
      dataState: string | null;
      summary: string[];
      exportSummary: unknown;
      scopes: ScopeOverview[];
      howToRead: string;
    }
  | ({ ok: true; source: string; name: string } & DataSlice)
  | {
      ok: false;
      error: string;
      source: string;
      message: string;
      availableScopes?: string[];
      nextSteps?: string[];
    };

/**
 * The bounded answer to show_data: an overview of a dataset, or one page of
 * one scope. Never the whole dataset, which can be tens of megabytes.
 */
export async function showData(
  args: ShowDataArgs,
  deps: McpServerDeps = {},
): Promise<ShowDataResult> {
  const result = await (deps.queryDataShow ?? queryDataShow)(args.source);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      source: result.source,
      message: result.message,
      ...("nextSteps" in result ? { nextSteps: result.nextSteps } : {}),
    };
  }

  if (!args.scope) {
    const scopes = describeScopes(result.data);
    const example = scopes.find((entry) => entry.kind === "list") ?? scopes[0];
    return {
      ok: true,
      source: result.source,
      name: result.name,
      path: result.path,
      lastRunAt: result.lastRunAt,
      dataState: result.dataState ?? null,
      summary: result.summary?.lines ?? [],
      exportSummary: result.data.exportSummary ?? null,
      scopes,
      howToRead: example
        ? `Call show_data with source "${result.source}" and scope "${example.scope}" to read items; add offset/limit to page and query to filter.`
        : "This dataset holds no scopes to read.",
    };
  }

  try {
    return {
      ok: true,
      source: result.source,
      name: result.name,
      ...sliceScope(result.data, {
        scope: args.scope,
        offset: args.offset,
        limit: args.limit,
        query: args.query,
      }),
    };
  } catch (error) {
    if (error instanceof UnknownScopeError) {
      return {
        ok: false,
        error: "scope_not_found",
        source: result.source,
        message: error.message,
        availableScopes: error.available,
      };
    }
    throw error;
  }
}

// ── Child process runner for connect_source ──────────────────────────

/**
 * Run `vana connect <source> --json --ipc` as a child process.
 *
 * The MCP server's stdout is the JSON-RPC transport, so the connect flow
 * must run in a separate process. We collect the child's stdout (JSONL events)
 * and stderr, parse the final outcome, and return a structured summary.
 *
 * Uses --ipc instead of --no-input so the connector can pause for
 * credential input via file-based IPC rather than failing immediately.
 */
async function runConnectAsChild(source: string) {
  return new Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>((resolve) => {
    const child = spawn(
      process.execPath,
      [process.argv[1], "connect", source, "--json", "--ipc"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      resolve({
        content: [
          {
            type: "text",
            text: `Failed to start connect process: ${err.message}`,
          },
        ],
        isError: true,
      });
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      // Parse JSONL events from stdout
      const events: Record<string, unknown>[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Skip non-JSON lines
        }
      }

      // Find the final outcome event (last event with an "outcome" field)
      const outcomeEvent = [...events]
        .reverse()
        .find((e) => "outcome" in e || "event" in e);

      const summary = buildConnectSummary(source, code, events, outcomeEvent);

      // If the outcome indicates interactive input is needed, explain
      if (
        outcomeEvent &&
        (outcomeEvent.outcome === "needs_input" ||
          outcomeEvent.event === "needs_input")
      ) {
        summary.push(
          "",
          `This source requires interactive authentication. Run \`vana connect ${source}\` in a terminal to complete the flow.`,
        );
      }

      if (stderr.trim()) {
        summary.push("", "Stderr:", stderr.trim());
      }

      resolve({
        content: [{ type: "text", text: summary.join("\n") }],
        isError: code !== 0,
      });
    });
  });
}

/**
 * Build a human-readable summary from connect child process results.
 */
function buildConnectSummary(
  source: string,
  exitCode: number | null,
  events: Record<string, unknown>[],
  outcomeEvent: Record<string, unknown> | undefined,
): string[] {
  const lines: string[] = [];

  if (exitCode === 0) {
    lines.push(`Connected ${source} successfully.`);
  } else {
    lines.push(`Connect ${source} exited with code ${exitCode ?? "unknown"}.`);
  }

  // Summarize collected data from events
  const scopeEvents = events.filter(
    (e) => e.event === "scope_complete" || e.event === "scope_collected",
  );
  if (scopeEvents.length > 0) {
    lines.push(
      "",
      "Collected data:",
      ...scopeEvents.map((e) => {
        const scope = (e.scope as string) ?? (e.name as string) ?? "unknown";
        const count = e.count ?? e.itemCount;
        return count != null ? `  ${scope} (${count} items)` : `  ${scope}`;
      }),
    );
  }

  if (outcomeEvent) {
    const outcome =
      (outcomeEvent.outcome as string) ?? (outcomeEvent.event as string);
    if (
      outcome &&
      outcome !== "scope_complete" &&
      outcome !== "scope_collected"
    ) {
      lines.push("", `Outcome: ${outcome}`);
    }
    if (outcomeEvent.message) {
      lines.push(`Detail: ${outcomeEvent.message as string}`);
    }
  }

  return lines;
}
