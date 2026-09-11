/**
 * Local index of access requests this machine created.
 *
 * A request is written the moment it is created, not on approval: a
 * `--no-input` run prints a URL and exits, and the agent that comes back
 * later must be able to find the request without having kept the id.
 *
 * Entries are namespaced by app address, network and gateway host, so two
 * apps, two networks or a dev deployment never see each other's requests.
 *
 * The DCR status carries no owner address, so an approved entry records the
 * grant id and the CLI resolves the owner from the gateway when it needs
 * one (a read does).
 */

import fs from "node:fs";
import path from "node:path";
import { getVanaHome } from "./paths.js";

export type StoredRequestStatus =
  | "pending"
  | "approved"
  | "ready_for_read"
  | "completed"
  | "denied"
  | "expired";

export interface StoredRequest {
  requestId: string;
  /** App address that created it. */
  appAddress: string;
  network: string;
  gatewayUrl: string;
  /** Scopes asked for, verbatim (may carry `write:` prefixes). */
  scopes: string[];
  approvalUrl: string;
  createdAt: string;
  status: StoredRequestStatus;
  updatedAt: string;
  expiresAt?: string;
  /** Present once approved. */
  grantId?: string;
  /** Approved scopes as reported by the status route. */
  approvedScopes?: string[];
  /** `enclave` or `personal_server`, once the status route reports it. */
  delivery?: string;
  personalServerUrl?: string;
  /** Derivative questions carried on the request, when any. */
  questions?: { derivedScope: string; sourceScopes: string[] }[];
}

interface RequestsFile {
  version: 1;
  requests: StoredRequest[];
}

const EMPTY: RequestsFile = { version: 1, requests: [] };

export interface RequestsStore {
  save(request: StoredRequest): void;
  /** Merge fields into an existing entry; no-op when it is unknown. */
  update(requestId: string, patch: Partial<StoredRequest>): void;
  get(requestId: string): StoredRequest | null;
  /** Newest first, optionally filtered to one app/network pair. */
  list(filter?: { appAddress?: string; network?: string }): StoredRequest[];
}

export function createRequestsStore(filePath?: string): RequestsStore {
  const file = filePath ?? path.join(getVanaHome(), "app", "requests.json");

  function read(): RequestsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RequestsFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.requests)) {
        return structuredClone(EMPTY);
      }
      return parsed;
    } catch {
      return structuredClone(EMPTY);
    }
  }

  function write(state: RequestsFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  return {
    save(request: StoredRequest): void {
      const state = read();
      const index = state.requests.findIndex(
        (entry) => entry.requestId === request.requestId,
      );
      if (index >= 0) {
        state.requests[index] = request;
      } else {
        state.requests.push(request);
      }
      write(state);
    },
    update(requestId: string, patch: Partial<StoredRequest>): void {
      const state = read();
      const index = state.requests.findIndex(
        (entry) => entry.requestId === requestId,
      );
      if (index < 0) {
        return;
      }
      state.requests[index] = {
        ...state.requests[index],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      write(state);
    },
    get(requestId: string): StoredRequest | null {
      return (
        read().requests.find((entry) => entry.requestId === requestId) ?? null
      );
    },
    list(filter): StoredRequest[] {
      return read()
        .requests.filter((entry) => {
          if (
            filter?.appAddress &&
            entry.appAddress.toLowerCase() !== filter.appAddress.toLowerCase()
          ) {
            return false;
          }
          if (filter?.network && entry.network !== filter.network) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
