import fs from "node:fs/promises";

import type { CliEvent, PersonalServerState } from "../core/cli-types.js";
import { readCliConfig } from "../core/state-store.js";
import { resolveScopes } from "./scope-resolver.js";
import { createPersonalServerClient } from "./client.js";
import { readCachedConnectorMetadata } from "../connectors/registry.js";
import { getConnectorCacheDir } from "../core/paths.js";
import {
  exportDigest,
  readExportReceipt,
  sameExportOwner,
} from "../core/source-export.js";
import type { SourceExportReceipt } from "../core/source-export.js";
import {
  loadAccountAddressForOwnership,
  loadExportOwner,
  loadPersonalServerSession,
} from "../cli/auth.js";

export { createPersonalServerClient } from "./client.js";
export type {
  PersonalServerClient,
  IngestScopeResult,
  ScopeSummary,
} from "./client.js";

const DEFAULT_PORTS = [8080, 8081, 8082, 8083, 8084, 8085];

export interface PersonalServerHealth {
  status: string;
  version: string;
  uptime: number;
  owner: string | null;
  /** The server's own address, which its registration is keyed by. */
  identity?: string | null;
  /** The gateway it serves, which says its network. */
  gatewayUrl?: string | null;
  /**
   * Where the server answers right now: its tunnel URL once that is up,
   * otherwise its configured (local) origin.
   */
  apiOrigin?: string | null;
}

export interface PersonalServerTarget {
  state: PersonalServerState;
  url: string | null;
  source: "config" | "auth" | "env" | "scan" | null;
  health: PersonalServerHealth | null;
}

export type PersonalServerAuthConfig =
  | { type: "bearerToken"; token: string }
  | { type: "none" }
  | undefined;

export interface IngestResultOptions {
  scopes?: string[];
  export:
    | { kind: "retry"; receipt: unknown }
    | {
        kind: "fresh";
        receipt: SourceExportReceipt;
        /** A person's destination consent applies to this collection only. */
        allowForeignServer: boolean;
      };
}

/**
 * The owner/account pair to warn about, or null when the server is ours.
 *
 * A Personal Server owned by another identity still accepts a device login
 * and still reports a successful ingest, so a mismatch has to surface before
 * data is written rather than after.
 */
export function personalServerOwnerMismatch(
  owner: string | null | undefined,
  accountAddress: string | null | undefined,
): { owner: string; account: string } | null {
  // An env-sourced session carries no real address to compare against.
  if (!owner || !accountAddress || accountAddress === "env") return null;
  if (owner.toLowerCase() === accountAddress.toLowerCase()) return null;
  return { owner, account: accountAddress };
}

async function detectTargetAt(
  url: string,
  source: PersonalServerTarget["source"],
): Promise<PersonalServerTarget | null> {
  const health = await fetchHealth(url);
  if (!health) {
    return null;
  }

  return {
    state: "available",
    url,
    source,
    health,
  };
}

export async function detectPersonalServerTarget(): Promise<PersonalServerTarget> {
  // 1. Persisted config (highest priority)
  const config = await readCliConfig();
  if (config.personalServerUrl) {
    const target = await detectTargetAt(config.personalServerUrl, "config");
    if (target) {
      return target;
    }
  }

  // 2. Auth credentials (from `vana login`). The saved server can be another
  // account's, kept across a login switch: then a server of this account
  // found by the scan below wins over it.
  const account = loadAccountAddressForOwnership();
  const savedSession = loadPersonalServerSession();
  let savedForeign: PersonalServerTarget | null = null;
  if (savedSession?.url) {
    const target = await detectTargetAt(savedSession.url, "auth");
    if (target && !personalServerOwnerMismatch(target.health?.owner, account)) {
      return target;
    }
    savedForeign = target;
  }

  // 3. Environment variable
  const explicitUrl = process.env.VANA_PERSONAL_SERVER_URL;
  if (explicitUrl) {
    const target = await detectTargetAt(explicitUrl, "env");
    if (target) {
      return target;
    }
  }

  // 4. Localhost port scan. One machine can host servers for several
  // identities, so the first port to answer is not necessarily ours; prefer
  // one the saved account owns and only fall back to a stranger's.
  let unowned: PersonalServerTarget | null = null;
  for (const port of DEFAULT_PORTS) {
    const url = `http://localhost:${port}`;
    const health = await fetchHealth(url);
    if (!health) continue;
    const target: PersonalServerTarget = {
      state: "available",
      url,
      source: "scan",
      health,
    };
    if (!personalServerOwnerMismatch(health.owner, account)) {
      return target;
    }
    unowned ??= target;
  }
  if (savedForeign) {
    return savedForeign;
  }
  if (unowned) {
    return unowned;
  }

  return { state: "unavailable", url: null, source: null, health: null };
}

export async function ingestResult(
  source: string,
  resultPath: string,
  target: PersonalServerTarget,
  options: IngestResultOptions,
): Promise<CliEvent[]> {
  if (target.state !== "available" || !target.url) {
    return [
      {
        type: "ingest-skipped",
        source,
        reason: "personal_server_unavailable",
      },
    ];
  }

  const receipt = readExportReceipt(options.export.receipt);
  const selected = loadExportOwner();
  const blocked = (
    reason: string,
    detail: string,
    remedy = "Use `vana data show` to inspect it.",
  ): CliEvent[] => [
    {
      type: "ingest-skipped",
      source,
      reason,
      message: `${detail} Export kept locally at ${resultPath}. ${remedy}`,
    },
  ];
  if (!receipt || receipt.path !== resultPath) {
    return blocked(
      "export_unattributed",
      "The export has no valid collection account receipt.",
    );
  }
  if (options.export.kind === "retry") {
    if (!receipt.owner)
      return blocked(
        "export_unattributed",
        "The export's collection account is unknown.",
      );
    if (!sameExportOwner(receipt.owner, selected)) {
      return blocked(
        "export_owner_mismatch",
        "The selected Account deployment or account does not own this export.",
        `Sign in as ${receipt.owner.address} at ${receipt.owner.accountUrl}, then run \`vana server sync\`.`,
      );
    }
    if (
      !target.health?.owner ||
      target.health.owner.toLowerCase() !== receipt.owner.address.toLowerCase()
    ) {
      return blocked(
        "export_server_owner_mismatch",
        "The Personal Server has not reported this export's collecting account as its owner.",
        "Select the collecting account's Personal Server, then run `vana server sync`.",
      );
    }
  } else if (receipt.owner) {
    if (!sameExportOwner(receipt.owner, selected)) {
      return blocked(
        "export_owner_mismatch",
        "The collecting account changed before this export could be uploaded.",
      );
    }
    if (
      personalServerOwnerMismatch(
        target.health?.owner,
        receipt.owner.address,
      ) &&
      !options.export.allowForeignServer
    ) {
      return blocked(
        "export_server_owner_mismatch",
        "The Personal Server belongs to another account.",
      );
    }
  }
  let raw: Buffer;
  try {
    raw = await fs.readFile(resultPath);
  } catch {
    return blocked(
      "export_unreadable",
      "The accepted export file cannot be read; no data was uploaded.",
    );
  }
  if (exportDigest(raw) !== receipt.sha256) {
    return blocked(
      "export_bytes_changed",
      "The export bytes changed after collection and cannot be safely synced.",
    );
  }
  const result = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const metadata = await readCachedConnectorMetadata(
    source,
    getConnectorCacheDir(),
  );
  const selectedScopes = options.scopes ? new Set(options.scopes) : null;
  const scopeMappings = resolveScopes(source, result, metadata).filter(
    (mapping) => !selectedScopes || selectedScopes.has(mapping.scope),
  );

  if (scopeMappings.length === 0) {
    return [
      {
        type: "ingest-skipped",
        source,
        reason: "no_scopes_resolved",
      },
    ];
  }

  const client = createPersonalServerClient({
    url: target.url,
    auth: resolvePersonalServerAuthConfig(target.url),
  });
  const events: CliEvent[] = [
    { type: "ingest-started", source, target: target.url },
  ];
  const scopeResults = [];

  for (const mapping of scopeMappings) {
    const scopeResult = await client.ingestScope(mapping.scope, mapping.data);
    scopeResults.push(scopeResult);
  }

  const allStored = scopeResults.every((r) => r.status === "stored");
  const allFailed = scopeResults.every((r) => r.status === "failed");

  if (allStored) {
    events.push({
      type: "ingest-complete",
      source,
      target: target.url,
      scopeResults,
    });
  } else if (allFailed) {
    events.push({
      type: "ingest-failed",
      source,
      target: target.url,
      message: scopeResults.map((r) => `${r.scope}: ${r.error}`).join("; "),
      scopeResults,
    });
  } else {
    events.push({
      type: "ingest-partial",
      source,
      target: target.url,
      scopeResults,
    });
  }

  return events;
}

export function resolvePersonalServerAuthConfig(
  serverUrl: string,
): PersonalServerAuthConfig {
  const psToken = process.env.VANA_PS_TOKEN;
  if (psToken) {
    return { type: "bearerToken", token: psToken };
  }

  // The PS session has its own expiry; an expired Account login must not
  // strip a still-valid token from every sync.
  const savedSession = loadPersonalServerSession();
  if (savedSession?.session_token && urlsMatch(savedSession.url, serverUrl)) {
    return { type: "bearerToken", token: savedSession.session_token };
  }

  return undefined;
}

// localhost, 127.0.0.1 and ::1 are the same server: a server reports one
// spelling and a port scan or a saved URL often uses another.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizeServerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (LOOPBACK_HOSTS.has(url.hostname)) {
      url.hostname = "localhost";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export function urlsMatch(left: string, right: string): boolean {
  return normalizeServerUrl(left) === normalizeServerUrl(right);
}

async function fetchHealth(
  baseUrl: string,
): Promise<PersonalServerHealth | null> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return {
      status: typeof body.status === "string" ? body.status : "unknown",
      version: typeof body.version === "string" ? body.version : "unknown",
      uptime: typeof body.uptime === "number" ? body.uptime : 0,
      owner: typeof body.owner === "string" ? body.owner : null,
      ...(typeof (body.identity as { address?: unknown } | undefined)
        ?.address === "string"
        ? { identity: (body.identity as { address: string }).address }
        : {}),
      ...(typeof body.gatewayUrl === "string"
        ? { gatewayUrl: body.gatewayUrl }
        : {}),
      ...(typeof body.apiOrigin === "string"
        ? { apiOrigin: body.apiOrigin }
        : {}),
    };
  } catch {
    return null;
  }
}
