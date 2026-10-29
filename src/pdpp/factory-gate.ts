import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { invoke, resolveExecutable } from "../core/factory-transport.js";
import {
  factoryVerificationSchema,
  type FactoryVerification,
} from "../core/factory-verification.js";

const uuid = z.string().uuid();
const attemptBase = z.object({
  version: z.literal(1),
  kind: z.literal("factory_collection_attempt"),
  attemptId: uuid,
  jobId: uuid,
  runId: z.string(),
  evidenceDirectory: z.string().refine(path.isAbsolute),
});
const attemptSchema = z.discriminatedUnion("status", [
  attemptBase.extend({ status: z.literal("collecting") }).strict(),
  attemptBase
    .extend({
      status: z.literal("verified"),
      receipt: factoryVerificationSchema,
    })
    .strict(),
  attemptBase
    .extend({
      status: z.literal("failed"),
      findings: z
        .array(
          z
            .object({
              code: z.string().regex(/^[a-z0-9_-]+$/),
              at: z.number().int(),
              count: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(100000),
    })
    .strict(),
  attemptBase.extend({ status: z.literal("cancelled") }).strict(),
]);
export interface FactoryBindingOptions {
  jobId: string;
  stateDirectory: string;
}
const publicFindingCodes = new Set([
  "evidence_unavailable",
  "host_outcome",
  "stdout_tail",
  "wire_json",
  "wire_shape",
  "exchange_shape",
  "exchange_duplicate",
  "exchange_unmatched",
  "exchange_missing",
  "wire_message_type",
  "required_coverage_missing",
  "incomplete_coverage",
  "stream_scope",
  "record_operation",
  "state_shape",
  "host_record_count",
  "evidence_or_context_invalid",
  "done-last",
  "done-shape",
  "records-count",
  "record-shape",
  "record-key-identity",
  "record-schema",
  "append-only-no-delete",
  "state-after-records",
  "no-secret-in-state",
  "no-own-time-in-data",
  "gap-shape",
  "coverage-keys",
  "gap-keys-backed",
  "coverage-unaccounted",
  "coverage-once-after",
  "coverage-present",
  "stream-failure-certified",
]);
/** Public failure metadata excludes raw evidence, field names and core errors. */
export class FactoryCollectionFailure extends Error {
  private constructor(attempt: z.infer<typeof attemptSchema>) {
    const findings =
      attempt.status === "failed"
        ? attempt.findings
            .slice(0, 20)
            .map(
              ({ code, at, count }) =>
                `${publicFindingCodes.has(code) ? code : "unknown_rule"} (index ${at}, count ${count})`,
            )
            .join("; ")
        : "";
    super(
      `Factory collection ${attempt.status === "cancelled" ? "cancelled" : "failed"}. Job ${attempt.jobId}; attempt ${attempt.attemptId}. Previous data and checkpoints were kept.${attempt.status === "failed" ? ` Findings (${attempt.findings.length}; showing at most 20): ${findings || "none"}.` : ""}`,
    );
    this.name = "FactoryCollectionFailure";
  }
  static fromAttempt(
    attempt: z.infer<typeof attemptSchema>,
  ): FactoryCollectionFailure {
    return new FactoryCollectionFailure(attemptSchema.parse(attempt));
  }
}
/** Keeps actual private wire evidence outside the checkout and all public output. */
export class FactoryCollectionGate {
  private fd: number | null = null;
  private seq = 0;
  private bytes = 0;
  private failed = false;
  private constructor(
    private readonly executable: string,
    private readonly options: FactoryBindingOptions,
    private readonly attempt: z.infer<typeof attemptBase>,
    private readonly signal?: AbortSignal,
  ) {}
  static async begin(
    options: FactoryBindingOptions,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<FactoryCollectionGate> {
    if (
      !uuid.safeParse(options.jobId).success ||
      !path.isAbsolute(options.stateDirectory)
    )
      throw new Error(
        "Factory binding requires an explicit job and absolute state directory.",
      );
    const executable = await resolveExecutable();
    const probe = await invoke(
      executable,
      ["capabilities", "--json"],
      true,
      signal,
    );
    const caps = z
      .object({
        collectionVerificationVersion: z.literal(1),
        orderedTranscriptVersion: z.literal(1),
        supported: z.literal(true),
        nodeVersion: z.string().regex(/^v(?:2[4-9]|[3-9]\d)\./),
        platform: z.enum(["darwin", "linux"]),
      })
      .safeParse(probe.value);
    if (probe.exitCode !== 0 || probe.interrupted || !caps.success)
      throw new Error(
        "Factory same-run verification capability is unavailable. No connector was started.",
      );
    const result = await FactoryCollectionGate.call(
      executable,
      options,
      "collection-preflight",
      request,
      signal,
    );
    const attempt = attemptSchema.parse(result.value);
    if (
      result.exitCode !== 0 ||
      result.interrupted ||
      attempt.status !== "collecting" ||
      attempt.jobId !== options.jobId
    )
      throw new Error(
        "Factory preflight rejected the collection. No connector was started.",
      );
    const expected = path.join(
      await realpath(options.stateDirectory),
      "jobs",
      options.jobId,
      "collections",
      attempt.attemptId,
    );
    if (attempt.evidenceDirectory !== expected)
      throw new Error("Factory evidence location is invalid.");
    const gate = new FactoryCollectionGate(
      executable,
      options,
      attempt,
      signal,
    );
    gate.fd = openSync(path.join(expected, "capture.part"), "wx", 0o600);
    return gate;
  }
  private static async call(
    executable: string,
    options: FactoryBindingOptions,
    operation: string,
    request: unknown,
    signal?: AbortSignal,
  ) {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "vana-factory-collection-"),
    );
    try {
      const bytes = JSON.stringify(request);
      if (Buffer.byteLength(bytes) > 64 * 1024 * 1024)
        throw new Error("Factory collection request exceeds 64 MiB.");
      const file = path.join(dir, "request.json");
      await writeFile(file, bytes, { mode: 0o600 });
      return await invoke(
        executable,
        [
          operation,
          "--job",
          options.jobId,
          "--request",
          file,
          "--state-dir",
          options.stateDirectory,
          "--json",
        ],
        true,
        signal,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  capture = (event: Record<string, unknown>): void => {
    if (this.failed || this.fd === null)
      throw new Error("Protocol evidence is unavailable.");
    const line = Buffer.from(
      `${JSON.stringify({ seq: this.seq++, ...event })}\n`,
    );
    this.bytes += line.length;
    if (this.bytes > 64 * 1024 * 1024) {
      this.failed = true;
      throw new Error("Protocol evidence exceeds 64 MiB.");
    }
    try {
      let offset = 0;
      while (offset < line.length)
        offset += writeSync(this.fd, line, offset, line.length - offset);
    } catch {
      this.failed = true;
      throw new Error("Protocol evidence capture failed.");
    }
  };
  async verify(): Promise<FactoryVerification> {
    if (this.fd === null)
      throw new Error(
        "Factory verification failed because evidence capture was incomplete.",
      );
    try {
      fsyncSync(this.fd);
    } finally {
      closeSync(this.fd);
      this.fd = null;
    }
    await rename(
      path.join(this.attempt.evidenceDirectory, "capture.part"),
      path.join(this.attempt.evidenceDirectory, "capture.ndjson"),
    );
    const result = await FactoryCollectionGate.call(
      this.executable,
      this.options,
      "verify-run",
      {
        version: 1,
        jobId: this.options.jobId,
        attemptId: this.attempt.attemptId,
        runId: this.attempt.runId,
      },
      this.signal?.aborted ? undefined : this.signal,
    );
    const attempt = attemptSchema.parse(result.value);
    if (
      result.exitCode !== 0 ||
      result.interrupted ||
      this.signal?.aborted ||
      attempt.status !== "verified" ||
      attempt.attemptId !== this.attempt.attemptId ||
      attempt.jobId !== this.options.jobId ||
      attempt.runId !== this.attempt.runId
    )
      throw FactoryCollectionFailure.fromAttempt(attempt);
    return attempt.receipt;
  }
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
