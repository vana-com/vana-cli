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
  funding: z
    .object({
      accountUrl: z.string().url(),
      idempotencyKey: z.string().uuid(),
    })
    .optional(),
  fundingProgress: z
    .object({
      status: z.enum(["pending", "funded", "not_needed", "failed"]),
      operationId: z.string().min(1).max(128).optional(),
    })
    .optional(),
});

/** Frozen setup and consent identity, saved before any funding or consent POST. */
export type StoredRequestIntent = z.infer<typeof intentSchema>;

/** A concurrent command owns the request journal; no mutation was performed. */
export class RequestsStoreBusyError extends Error {}

/** Another command already saved this unfinished setup. */
export class UnfinishedSetupError extends Error {
  constructor(readonly intent: StoredRequestIntent) {
    super("Resume the existing unfinished setup.");
  }
}

/** Fingerprint only immutable request identity and payload, never credentials. */
export function requestIntentHash(
  intent: Omit<StoredRequestIntent, "payloadHash">,
): string {
  const {
    setupId: _id,
    createdAt: _date,
    grantData: _grant,
    requestId: _remote,
    fundingProgress: _funding,
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
  /** Retain the service operation before polling or creating consent. */
  updateFunding(
    setupId: string,
    progress: NonNullable<StoredRequestIntent["fundingProgress"]>,
  ): NonNullable<StoredRequestIntent["fundingProgress"]>;
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

  // Publish a nonempty owner directory atomically. Renaming cannot replace
  // another nonempty lock, and cleanup removes only the observed owner's file.
  function withWriteLock<T>(mutate: () => T): T {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const token = `${randomUUID()}.json`;
    const prepared = `${lock}.${randomUUID()}.tmp`;
    fs.mkdirSync(prepared, { mode: 0o700 });
    let acquired = false;
    const removeEmptyLock = () => {
      try {
        fs.rmdirSync(lock);
      } catch (error) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    };
    try {
      fs.writeFileSync(
        path.join(prepared, token),
        JSON.stringify({ pid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          fs.renameSync(prepared, lock);
          acquired = true;
          break;
        } catch (error) {
          if (
            !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
          let owners: string[];
          let pid: number;
          try {
            owners = fs.readdirSync(lock);
            if (owners.length === 0) {
              removeEmptyLock();
              continue;
            }
            if (owners.length !== 1) throw new Error("Invalid lock owners");
            pid = z
              .object({ pid: z.number().int().positive() })
              .parse(
                JSON.parse(fs.readFileSync(path.join(lock, owners[0]), "utf8")),
              ).pid;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new RequestsStoreBusyError(
              "Cannot identify the request journal's writer.",
            );
          }
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              throw new RequestsStoreBusyError(
                "Another command is updating request state.",
              );
            try {
              fs.unlinkSync(path.join(lock, owners[0]));
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
                throw unlinkError;
            }
            // A successor's owner file makes this fail harmlessly with
            // ENOTEMPTY, even if it acquired the lock after the stale read.
            removeEmptyLock();
            continue;
          }
          throw new RequestsStoreBusyError(
            "Another command is updating request state.",
          );
        }
      }
      if (!acquired)
        throw new RequestsStoreBusyError("Cannot lock request state.");
      return mutate();
    } finally {
      try {
        if (acquired) {
          fs.unlinkSync(path.join(lock, token));
          removeEmptyLock();
        }
      } finally {
        fs.rmSync(prepared, { recursive: true, force: true });
      }
    }
  }

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
        if (
          intent.fundingProgress &&
          (!intent.funding ||
            (["funded", "failed"].includes(intent.fundingProgress.status) &&
              !intent.fundingProgress.operationId))
        )
          throw new Error("Invalid saved funding progress");
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
      return withWriteLock(() => {
        const parsed = intentSchema.parse(intent);
        const state = read();
        if (state.intents?.some((entry) => entry.setupId === parsed.setupId))
          throw new Error("Request intent already exists");
        const unfinished = state.intents?.find(
          (entry) =>
            !entry.requestId &&
            entry.appAddress.toLowerCase() ===
              parsed.appAddress.toLowerCase() &&
            entry.network === parsed.network &&
            entry.env === parsed.env &&
            entry.gatewayUrl === parsed.gatewayUrl &&
            JSON.stringify(entry.requestOptions) ===
              JSON.stringify(parsed.requestOptions),
        );
        if (unfinished) throw new UnfinishedSetupError(unfinished);
        state.intents = [...(state.intents ?? []), parsed];
        write(state);
      });
    },
    getIntent(setupId) {
      return read().intents?.find((entry) => entry.setupId === setupId) ?? null;
    },
    updateFunding(setupId, progress) {
      return withWriteLock(() => {
        const state = read();
        const intent = state.intents?.find(
          (entry) => entry.setupId === setupId,
        );
        if (
          !intent?.funding ||
          (intent.fundingProgress?.operationId &&
            intent.fundingProgress.operationId !== progress.operationId)
        )
          throw new Error("Conflicting funding identity");
        if (
          intent.fundingProgress &&
          intent.fundingProgress.status !== "pending"
        )
          return intent.fundingProgress;
        intent.fundingProgress =
          intentSchema.shape.fundingProgress.parse(progress);
        write(state);
        return intent.fundingProgress!;
      });
    },
    listIntents() {
      return read().intents ?? [];
    },
    save(request: StoredRequest, setupId?: string): void {
      return withWriteLock(() => {
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
      });
    },
    update(requestId: string, patch: Partial<StoredRequest>): void {
      return withWriteLock(() => {
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
      });
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
