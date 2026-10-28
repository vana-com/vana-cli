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
  /** Healthy servers passed over because they belong to another account. */
  otherServers?: { url: string; owner: string }[];
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

/** Resolve a destination, or inspect all reachable servers for status reporting. */
export async function detectPersonalServerTarget(
  options: { purpose?: "owner-inspection" } = {},
): Promise<PersonalServerTarget> {
  const inspecting = options.purpose === "owner-inspection";
  const account = loadAccountAddressForOwnership();
  const seen = new Set<string>();
  const probe = async (
    url: string | undefined,
    source: PersonalServerTarget["source"],
  ): Promise<PersonalServerTarget | null> => {
    if (!url) return null;
    const key = normalizeServerUrl(url);
    if (inspecting && seen.has(key)) return null;
    seen.add(key);
    return detectTargetAt(url, source);
  };
  const config = await readCliConfig();
  const configured = await probe(config.personalServerUrl, "config");
  // A configured URL is a deliberate destination, including a foreign server
  // whose use is subject to the collection command's existing consent check.
  if (configured && !inspecting) return configured;

  const saved = await probe(loadPersonalServerSession()?.url, "auth");
  if (
    saved &&
    !inspecting &&
    !personalServerOwnerMismatch(saved.health?.owner, account)
  ) {
    return saved;
  }

  const explicit = await probe(process.env.VANA_PERSONAL_SERVER_URL, "env");
  if (explicit && !inspecting) return explicit;

  const scanned = inspecting
    ? await Promise.all(
        DEFAULT_PORTS.map((port) => probe(`http://localhost:${port}`, "scan")),
      )
    : [];
  let scannedForeign: PersonalServerTarget | null = null;
  if (!inspecting) {
    for (const port of DEFAULT_PORTS) {
      const target = await probe(`http://localhost:${port}`, "scan");
      if (!target) continue;
      if (!personalServerOwnerMismatch(target.health?.owner, account)) {
        return target;
      }
      scannedForeign ??= target;
    }
  }
  const unavailable: PersonalServerTarget = {
    state: "unavailable",
    url: null,
    source: null,
    health: null,
  };
  if (!inspecting) return saved ?? scannedForeign ?? unavailable;

  const candidates = [configured, saved, explicit, ...scanned].filter(
    (target): target is PersonalServerTarget => target !== null,
  );
  const selected =
    candidates.find(
      (target) => !personalServerOwnerMismatch(target.health?.owner, account),
    ) ??
    candidates[0] ??
    unavailable;
  const otherServers = candidates.flatMap((target) => {
    const mismatch = personalServerOwnerMismatch(target.health?.owner, account);
    return mismatch && target.url && target !== selected
      ? [{ url: target.url, owner: mismatch.owner }]
      : [];
  });
  return otherServers.length ? { ...selected, otherServers } : selected;
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
