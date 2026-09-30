/**
 * Outcome contract for the builder (`vana app`) command group.
 *
 * Every app command ends by emitting exactly one outcome through
 * {@link emitAppOutcome}: a single JSON line in `--json` mode, readable
 * lines otherwise. The exit code always comes from the protocol `code`
 * through the binary-wide table in `src/core/exit-codes.ts`.
 */

import { z } from "zod";
import {
  exitCodeForProtocolCode,
  type CliExitCode,
} from "../../core/exit-codes.js";
import type { VanaNetworkName } from "../../core/network.js";

export const APP_OUTCOME_STATUSES = ["done", "failed"] as const;
export type AppOutcomeStatus = (typeof APP_OUTCOME_STATUSES)[number];

export interface AppOutcomeInput {
  status: AppOutcomeStatus;
  /** Stable protocol code; drives the exit code. `ok` for success. */
  code: string;
  message: string;
  remedy?: string;
  network?: VanaNetworkName;
  data?: Record<string, unknown>;
}

export const appOutcomeSchema = z
  .object({
    type: z.literal("outcome"),
    status: z.enum(APP_OUTCOME_STATUSES),
    code: z.string(),
    exitCode: z.number().int().min(0).max(7),
    message: z.string(),
    remedy: z.string().optional(),
    network: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export interface AppCommandOptions {
  json?: boolean;
  noInput?: boolean;
  quiet?: boolean;
  yes?: boolean;
  network?: VanaNetworkName;
}

/** Emit the terminal outcome and return the exit code for the command. */
export function emitAppOutcome(
  options: AppCommandOptions,
  outcome: AppOutcomeInput,
): CliExitCode {
  const exitCode = exitCodeForProtocolCode(outcome.code);
  if (options.json) {
    const payload = appOutcomeSchema.parse({
      type: "outcome",
      status: outcome.status,
      code: outcome.code,
      exitCode,
      message: outcome.message,
      ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
      ...(outcome.network ? { network: outcome.network } : {}),
      ...(outcome.data ? { data: outcome.data } : {}),
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return exitCode;
  }

  const stream = outcome.status === "done" ? process.stdout : process.stderr;
  stream.write(`${outcome.message}\n`);
  if (!options.quiet) {
    for (const [key, value] of Object.entries(outcome.data ?? {})) {
      if (value !== undefined && value !== null) {
        stream.write(renderField(key, value, "  "));
      }
    }
    if (outcome.remedy) {
      stream.write(`  next: ${outcome.remedy}\n`);
    }
  }
  return exitCode;
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function isFlatRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPrimitive)
  );
}

function renderInline(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(", ");
}

/**
 * One `data` field for human mode. `String()` on an object prints
 * "[object Object]", so structure is spelled out instead: a list of values on
 * one line, a flat record as "key value" pairs, and anything deeper as an
 * indented block. JSON mode is untouched; it prints `data` as it is.
 */
export function renderField(
  key: string,
  value: unknown,
  indent: string,
): string {
  if (isPrimitive(value)) {
    return `${indent}${key}: ${String(value)}\n`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}${key}: none\n`;
    }
    if (value.every(isPrimitive)) {
      return `${indent}${key}: ${value.map(String).join(", ")}\n`;
    }
    return (
      `${indent}${key}:\n` +
      value
        .map((item) =>
          isFlatRecord(item)
            ? `${indent}  - ${renderInline(item)}\n`
            : isPrimitive(item)
              ? `${indent}  - ${String(item)}\n`
              : `${indent}  -\n` +
                Object.entries(item as Record<string, unknown>)
                  .filter(([, v]) => v !== undefined && v !== null)
                  .map(([k, v]) => renderField(k, v, `${indent}    `))
                  .join(""),
        )
        .join("")
    );
  }
  if (isFlatRecord(value)) {
    return `${indent}${key}: ${renderInline(value)}\n`;
  }
  return (
    `${indent}${key}:\n` +
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => renderField(k, v, `${indent}  `))
      .join("")
  );
}
