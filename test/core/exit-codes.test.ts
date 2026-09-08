import { describe, expect, it } from "vitest";
import {
  CliOutcomeStatus,
  cliOutcomeSchema,
} from "../../src/core/cli-types.js";
import {
  CliExitCode,
  exitCodeForOutcome,
  exitCodeForProtocolCode,
} from "../../src/core/exit-codes.js";

describe("exitCodeForOutcome", () => {
  it("maps success statuses to 0", () => {
    expect(exitCodeForOutcome(CliOutcomeStatus.CONNECTED_AND_INGESTED)).toBe(
      CliExitCode.OK,
    );
    expect(exitCodeForOutcome(CliOutcomeStatus.CONNECTED_LOCAL_ONLY)).toBe(
      CliExitCode.OK,
    );
  });

  it("maps server unavailability to 5", () => {
    expect(
      exitCodeForOutcome(CliOutcomeStatus.PERSONAL_SERVER_UNAVAILABLE),
    ).toBe(CliExitCode.SERVER_UNAVAILABLE);
  });

  it("maps needs_input to 7 (a person has to act)", () => {
    expect(exitCodeForOutcome(CliOutcomeStatus.NEEDS_INPUT)).toBe(
      CliExitCode.CONFIRMATION_REQUIRED,
    );
  });

  it("maps everything else to plain failure", () => {
    expect(exitCodeForOutcome(CliOutcomeStatus.RUNTIME_ERROR)).toBe(
      CliExitCode.FAILURE,
    );
    expect(exitCodeForOutcome(CliOutcomeStatus.AUTH_FAILED)).toBe(
      CliExitCode.FAILURE,
    );
    expect(exitCodeForOutcome(CliOutcomeStatus.CONNECTOR_UNAVAILABLE)).toBe(
      CliExitCode.FAILURE,
    );
  });
});

describe("exitCodeForProtocolCode", () => {
  it("covers the documented table", () => {
    expect(exitCodeForProtocolCode("grant_invalid")).toBe(CliExitCode.NO_GRANT);
    expect(exitCodeForProtocolCode("grant_revoked")).toBe(CliExitCode.NO_GRANT);
    expect(exitCodeForProtocolCode("payment_required")).toBe(
      CliExitCode.PAYMENT_REQUIRED,
    );
    expect(exitCodeForProtocolCode("max_fee_exceeded")).toBe(
      CliExitCode.PAYMENT_REQUIRED,
    );
    expect(exitCodeForProtocolCode("owner_not_ready")).toBe(
      CliExitCode.SERVER_UNAVAILABLE,
    );
    expect(exitCodeForProtocolCode("scope_not_found")).toBe(
      CliExitCode.SERVER_UNAVAILABLE,
    );
    expect(exitCodeForProtocolCode("not_ready")).toBe(CliExitCode.NOT_READY);
    expect(exitCodeForProtocolCode("version_mismatch")).toBe(
      CliExitCode.NOT_READY,
    );
    expect(exitCodeForProtocolCode("confirmation_required")).toBe(
      CliExitCode.CONFIRMATION_REQUIRED,
    );
    expect(exitCodeForProtocolCode("bad_usage")).toBe(CliExitCode.USAGE);
  });

  it("normalizes the codes the SDK actually throws", () => {
    expect(exitCodeForProtocolCode("JOB_OWNER_NOT_READY")).toBe(
      CliExitCode.SERVER_UNAVAILABLE,
    );
    expect(exitCodeForProtocolCode("JOB_GRANT_INVALID")).toBe(
      CliExitCode.NO_GRANT,
    );
    expect(exitCodeForProtocolCode("JOB_TIMEOUT")).toBe(CliExitCode.NOT_READY);
    expect(exitCodeForProtocolCode("GRANT_INVALID")).toBe(CliExitCode.NO_GRANT);
    expect(exitCodeForProtocolCode("OWNER_NOT_READY")).toBe(
      CliExitCode.SERVER_UNAVAILABLE,
    );
  });

  it("falls back to failure for unknown codes", () => {
    expect(exitCodeForProtocolCode("builder_unknown")).toBe(
      CliExitCode.FAILURE,
    );
    expect(exitCodeForProtocolCode("whatever_else")).toBe(CliExitCode.FAILURE);
  });
});

describe("cliOutcomeSchema", () => {
  it("accepts a valid outcome with extra fields", () => {
    const parsed = cliOutcomeSchema.parse({
      type: "outcome",
      status: CliOutcomeStatus.CONNECTED_AND_INGESTED,
      source: "github",
      extra: { anything: true },
    });
    expect(parsed.status).toBe("connected_and_ingested");
  });

  it("rejects a wrong type or unknown status", () => {
    expect(() =>
      cliOutcomeSchema.parse({ type: "event", status: "runtime_error" }),
    ).toThrow();
    expect(() =>
      cliOutcomeSchema.parse({ type: "outcome", status: "not_a_status" }),
    ).toThrow();
  });
});
