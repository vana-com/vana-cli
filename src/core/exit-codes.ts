/**
 * The one exit-code table for the whole binary.
 *
 * The previous contract was 0/1 only (every failure path returned 1, bad
 * usage inherited commander's 1), while docs/CLI-AGENT-FRIENDLY.md claimed a
 * different set of meanings for 2-5 that was never implemented. Both are
 * replaced by this table; docs/CLI-EXIT-CODE-MATRIX.md is the human copy.
 *
 * Codes exist so an agent can branch without parsing prose. The JSON
 * outcome's `code` field carries the finer-grained reason.
 */

import { CliOutcomeStatus } from "./cli-types.js";

export const CliExitCode = {
  /** Done. */
  OK: 0,
  /** Failed for a reason no other code names. */
  FAILURE: 1,
  /** Bad usage: unknown command, unknown option, missing argument. */
  USAGE: 2,
  /** No grant, or the grant does not cover this. */
  NO_GRANT: 3,
  /** Payment required and not settled. */
  PAYMENT_REQUIRED: 4,
  /** No server holding this data answered (incl. owner not ready). */
  SERVER_UNAVAILABLE: 5,
  /** Not ready yet, come back. */
  NOT_READY: 6,
  /** A person has to confirm before this can proceed. */
  CONFIRMATION_REQUIRED: 7,
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

/**
 * Exit code for an owner-side outcome status.
 *
 * Only statuses with an unambiguous slot in the table map to a distinct
 * code; the rest stay {@link CliExitCode.FAILURE} with the status itself in
 * the JSON payload. Success statuses map to OK.
 */
export function exitCodeForOutcome(status: CliOutcomeStatus): CliExitCode {
  switch (status) {
    case CliOutcomeStatus.CONNECTED_AND_INGESTED:
    case CliOutcomeStatus.CONNECTED_LOCAL_ONLY:
      return CliExitCode.OK;
    case CliOutcomeStatus.PERSONAL_SERVER_UNAVAILABLE:
      return CliExitCode.SERVER_UNAVAILABLE;
    case CliOutcomeStatus.NEEDS_INPUT:
      return CliExitCode.CONFIRMATION_REQUIRED;
    default:
      return CliExitCode.FAILURE;
  }
}

/**
 * Protocol-level error classes the builder command group maps onto the
 * table. Keys are the stable `code` values emitted in JSON outcomes.
 */
export const PROTOCOL_EXIT_MAP: Record<string, CliExitCode> = {
  ok: CliExitCode.OK,
  bad_usage: CliExitCode.USAGE,
  grant_invalid: CliExitCode.NO_GRANT,
  grant_revoked: CliExitCode.NO_GRANT,
  payment_required: CliExitCode.PAYMENT_REQUIRED,
  max_fee_exceeded: CliExitCode.PAYMENT_REQUIRED,
  server_unavailable: CliExitCode.SERVER_UNAVAILABLE,
  scope_not_found: CliExitCode.SERVER_UNAVAILABLE,
  owner_not_ready: CliExitCode.SERVER_UNAVAILABLE,
  not_ready: CliExitCode.NOT_READY,
  version_mismatch: CliExitCode.NOT_READY,
  confirmation_required: CliExitCode.CONFIRMATION_REQUIRED,
  builder_unknown: CliExitCode.FAILURE,
  internal: CliExitCode.FAILURE,
};

/**
 * Aliases for codes the SDK and gateway actually emit (jobs-client error
 * `.code` values, gateway admission codes), normalized onto the table's
 * stable keys. Extend here as the adapter meets new shapes; unknown codes
 * stay FAILURE rather than guessing.
 */
const PROTOCOL_CODE_ALIASES: Record<string, string> = {
  job_owner_not_ready: "owner_not_ready",
  job_grant_invalid: "grant_invalid",
  job_timeout: "not_ready",
  job_not_found: "internal",
  job_id_taken: "internal",
  job_request_too_large: "bad_usage",
  builder_unknown: "builder_unknown",
  grant_invalid: "grant_invalid",
  owner_not_ready: "owner_not_ready",
};

/** Lowercase and strip the transport prefixes real SDK codes carry. */
export function normalizeProtocolCode(code: string): string {
  const lower = code.trim().toLowerCase();
  return PROTOCOL_CODE_ALIASES[lower] ?? lower;
}

export function exitCodeForProtocolCode(code: string): CliExitCode {
  return PROTOCOL_EXIT_MAP[normalizeProtocolCode(code)] ?? CliExitCode.FAILURE;
}
