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
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
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
  /**
   * Scopes asked for, verbatim (may carry `write:` prefixes), after the
   * app's live grant was merged in.
   */
  scopes: string[];
  /** Live grant entries the request gave up (`--remove-scopes`). */
  removeScopes?: string[];
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
  intents?: StoredRequestIntent[];
}

const intentSchema = z.object({
  setupId: z.string().regex(/^setup_[a-f0-9-]+$/),
  createdAt: z.string(),
  appAddress: z.string(),
  network: z.enum(["moksha", "mainnet"]),
  env: z.enum(["dev", "prod"]),
  gatewayUrl: z.string(),
  approvalBaseUrl: z.string(),
  app: z.object({ id: z.string(), name: z.string(), homepageUrl: z.string() }),
  source: z.string(),
  scopes: z.array(z.string()),
  input: z.object({
    returnUrl: z.string(),
    idempotencyKey: z.string().uuid(),
    removeScopes: z.array(z.string()).optional(),
    questions: z
      .array(
        z.object({
          derivedScope: z.string(),
          sourceScopes: z.array(z.string()),
          question: z.string(),
        }),
      )
      .optional(),
  }),
  requestOptions: z.record(z.string(), z.union([z.string(), z.boolean()])),
  grantData: z.record(z.string(), z.unknown()),
  payloadHash: z.string(),
  requestId: z.string().optional(),
});

/** Frozen consent creation, saved before the remote request ID exists. */
export type StoredRequestIntent = z.infer<typeof intentSchema>;

/** Fingerprint only immutable request identity and payload, never credentials. */
export function requestIntentHash(
  intent: Omit<StoredRequestIntent, "payloadHash">,
): string {
  const {
    setupId: _id,
    createdAt: _date,
    grantData: _grant,
    requestId: _remote,
    ...payload
  } = intent;
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
}

const EMPTY: RequestsFile = { version: 1, requests: [] };

export interface RequestsStore {
  save(request: StoredRequest, setupId?: string): void;
  saveIntent(intent: StoredRequestIntent): void;
  getIntent(setupId: string): StoredRequestIntent | null;
  listIntents(): StoredRequestIntent[];
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
        throw new Error("Invalid request store");
      }
      parsed.intents = (parsed.intents ?? []).map((entry) => {
        const intent = intentSchema.parse(entry);
        const { payloadHash, ...payload } = intent;
        if (requestIntentHash(payload) !== payloadHash)
          throw new Error("Saved request payload changed");
        return intent;
      });
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY);
      throw error;
    }
  }

  function write(state: RequestsFile): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      if (process.platform !== "win32") {
        const fd = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  return {
    saveIntent(intent) {
      const parsed = intentSchema.parse(intent);
      const state = read();
      if (state.intents?.some((entry) => entry.setupId === parsed.setupId))
        throw new Error("Request intent already exists");
      state.intents = [...(state.intents ?? []), parsed];
      write(state);
    },
    getIntent(setupId) {
      return read().intents?.find((entry) => entry.setupId === setupId) ?? null;
    },
    listIntents() {
      return read().intents ?? [];
    },
    save(request: StoredRequest, setupId?: string): void {
      const state = read();
      if (setupId) {
        const intent = state.intents?.find(
          (entry) => entry.setupId === setupId,
        );
        if (
          !intent ||
          (intent.requestId && intent.requestId !== request.requestId)
        )
          throw new Error("Conflicting request identity");
        intent.requestId = request.requestId;
      }
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
