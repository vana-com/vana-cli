import { createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const shelfBoundaries = [
  "approval",
  "personal-server",
  "consumer",
  "browser",
  "collection",
  "ingestion",
] as const;
export const shelfStages = [
  "approval",
  "read",
  "payment",
  "save",
  "render",
  "ack",
  "reload",
  "collection",
  "ingestion",
] as const;
export const shelfOutcomes = [
  "started",
  "ok",
  "failed",
  "interrupted",
  "unknown",
] as const;
export const shelfReasons = [
  "request_created",
  "pending",
  "approved",
  "completed",
  "denied",
  "expired",
  "cancelled",
  "approval_required",
  "grant_invalid",
  "server_invalid",
  "payment_disabled",
  "fee_cap_exceeded",
  "funding_required",
  "fee_quote_changed",
  "payment_invalid",
  "payment_unconfirmed",
  "http_error",
  "transport_error",
  "save_failed",
  "save_required",
  "connection_required",
  "invalid_request",
  "invalid_data",
  "network_refused",
  "read_failed",
  "ack_failed",
  "recovered",
  "already_acknowledged",
  "unknown_error",
] as const;

export interface ShelfObservation {
  observer?: "research-shelf" | "verifier";
  boundary: (typeof shelfBoundaries)[number];
  stage: (typeof shelfStages)[number];
  outcome: (typeof shelfOutcomes)[number];
  attempt: string;
  requestId?: string;
  grantId?: string;
  revision?: string;
  reason?: (typeof shelfReasons)[number];
  status?: number;
  count?: number;
  durationMs?: number;
}

export interface ShelfObserver {
  observe(input: ShelfObservation): Promise<void>;
  attempt(): string;
}

export interface ShelfObserverOptions {
  file?: string;
  run?: string;
  mode?: string;
  salt?: string;
}

const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const noop: ShelfObserver = { observe: async () => {}, attempt: randomUUID };

/** Write only allowlisted metadata. Observation failures never change delivery. */
export function createShelfObserver(
  options: ShelfObserverOptions = {},
): ShelfObserver {
  const { file, run, mode, salt } = options;
  if (
    !file ||
    !path.isAbsolute(file) ||
    !run ||
    !uuid.test(run) ||
    !["controlled", "live"].includes(mode ?? "") ||
    !salt ||
    !/^[a-f\d]{64}$/i.test(salt)
  )
    return noop;
  const alias = (kind: string, value: string) =>
    createHmac("sha256", salt)
      .update(`${kind}:${value}`)
      .digest("hex")
      .slice(0, 20);
  return {
    attempt: randomUUID,
    async observe(input) {
      try {
        if (
          !shelfBoundaries.includes(input.boundary) ||
          !shelfStages.includes(input.stage) ||
          !shelfOutcomes.includes(input.outcome) ||
          !uuid.test(input.attempt)
        )
          return;
        const row: Record<string, string | number> = {
          schema: 1,
          timestamp: new Date().toISOString(),
          eventId: randomUUID(),
          run,
          mode: mode ?? "live",
          observer:
            input.observer === "verifier" ? "verifier" : "research-shelf",
          boundary: input.boundary,
          stage: input.stage,
          outcome: input.outcome,
          attempt: input.attempt,
        };
        for (const [name, value] of [
          ["request", input.requestId],
          ["grant", input.grantId],
          ["revision", input.revision],
        ] as const)
          if (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 4096
          )
            row[`${name}Alias`] = alias(name, value);
        if (input.reason && shelfReasons.includes(input.reason))
          row.reason = input.reason;
        if (
          Number.isInteger(input.status) &&
          input.status !== undefined &&
          input.status >= 100 &&
          input.status <= 599
        )
          row.status = input.status;
        for (const key of ["count", "durationMs"] as const)
          if (
            Number.isSafeInteger(input[key]) &&
            input[key] !== undefined &&
            input[key] >= 0
          )
            row[key] = input[key];
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      } catch {
        /* The product retains its original outcome when local observation is unavailable. */
      }
    },
  };
}

/** Enable the local sink only when all four explicit settings are present. */
export function shelfObserverFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ShelfObserver {
  return createShelfObserver({
    file: env.VANA_SHELF_OBSERVABILITY_FILE,
    run: env.VANA_SHELF_OBSERVABILITY_RUN,
    mode: env.VANA_SHELF_OBSERVABILITY_MODE,
    salt: env.VANA_SHELF_OBSERVABILITY_SALT,
  });
}
