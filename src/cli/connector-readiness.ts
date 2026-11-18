import { z } from "zod";

const text = z
  .string()
  .min(1)
  .max(12_000)
  .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/);
const name = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const tierSchema = z.enum(["development", "preview", "supported"]);

/** Upstream-owned verdicts and requirements; legacy reports remain visible. */
export const conformanceReportSchema = z
  .object({
    schema: z.literal("pdpp.conformance-report/1").optional(),
    base_revision: revision.nullable().optional(),
    connector: name,
    tier: tierSchema.nullable().optional(),
    mode: z.enum(["full", "static"]).optional(),
    subject: z
      .object({
        revision: revision.nullable(),
        clean: z.boolean(),
        source_digest: hash.nullable(),
        declaration_digest: hash.nullable(),
      })
      .strict()
      .optional(),
    isKnownScaffold: z.boolean(),
    steps: z
      .array(
        z
          .object({
            name,
            verdict: z.enum(["PASS", "FAIL", "UNKNOWN", "WEAK", "ADVISORY"]),
            detail: text,
            nextAction: text.optional(),
            advisory: z.boolean().optional(),
            required_for_review: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (report) =>
      new Set(report.steps.map((step) => step.name)).size ===
      report.steps.length,
    "Duplicate conformance steps",
  )
  .refine(
    (report) => Buffer.byteLength(JSON.stringify(report)) <= 65_536,
    "Conformance report exceeds 64 KiB",
  );

/** Reasons for non-required findings, keyed by the exact upstream step name. */
export const dispositionSchema = z
  .record(name, text)
  .refine((value) => Object.keys(value).length <= 100);

const claimSchema = z.object({
  schema: z.literal("pdpp.connector-claim/1"),
  connector: name.optional(),
  claim: name,
  captured_at: z.iso.datetime(),
  verified_at: z.iso.datetime(),
  captured_with: z
    .object({
      source_digest: hash.nullable(),
      declaration_digest: hash.nullable(),
    })
    .strict(),
  runs: z.number().int().positive(),
  drivers: z.array(name).max(100),
  coverage: z.array(name).max(100),
  limitations: z.array(text).max(100),
});
type Report = z.infer<typeof conformanceReportSchema>;
type AccountEvidence =
  | { status: "none" | "malformed" | "unverified" | "stale" }
  | {
      status: "bound";
      claim: string;
      capturedAt: string;
      verifiedAt: string;
      runs: number;
      coverage: string[];
      limitations: string[];
    };

/** Inspect the selected commit's public claim against upstream's checked subject. */
function accountEvidence(
  key: string,
  head: string,
  report: Report | undefined,
  claimText: string | null,
): AccountEvidence {
  if (claimText === null) return { status: "none" };
  if (Buffer.byteLength(claimText) > 65_536) return { status: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(claimText);
  } catch {
    return { status: "malformed" };
  }
  const parsed = claimSchema.safeParse(raw);
  if (
    !parsed.success ||
    (parsed.data.connector !== undefined && parsed.data.connector !== key)
  )
    return { status: "malformed" };
  const claim = parsed.data;
  const subject = report?.subject;
  if (
    !report ||
    !subject ||
    subject.revision !== head ||
    !subject.clean ||
    report.connector !== key ||
    report.schema !== "pdpp.conformance-report/1" ||
    report.mode !== "full"
  )
    return { status: "unverified" };
  if (
    !subject.source_digest ||
    !subject.declaration_digest ||
    claim.captured_with.source_digest !== subject.source_digest ||
    claim.captured_with.declaration_digest !== subject.declaration_digest
  )
    return { status: "stale" };
  if (
    report?.steps.find((step) => step.name === "evidence")?.verdict !== "PASS"
  )
    return { status: "unverified" };
  return {
    status: "bound",
    claim: claim.claim,
    capturedAt: claim.captured_at,
    verifiedAt: claim.verified_at,
    runs: claim.runs,
    coverage: claim.coverage,
    limitations: claim.limitations,
  };
}

/** Apply upstream's reported requirements to a proposed public submission. */
export function submissionReadiness(input: {
  key: string;
  head: string;
  base: string;
  manifest: unknown;
  report?: Report;
  omissions?: string;
  dispositions?: Record<string, string>;
  claimText: string | null;
}) {
  const manifest = z
    .object({
      capabilities: z.object({
        public_listing: z.object({ tier: tierSchema }),
      }),
    })
    .safeParse(input.manifest);
  const tier = manifest.success
    ? manifest.data.capabilities.public_listing.tier
    : null;
  const gaps: string[] = [];
  if (!tier) gaps.push("Choose the listing tier in the manifest.");
  if (!input.omissions)
    gaps.push("Describe scope omissions, or state that there are none.");
  const report = input.report;
  const dispositions = input.dispositions ?? {};
  if (!report)
    gaps.push(
      "Include the full upstream conformance JSON report for the submitted commit.",
    );
  else {
    if (report.schema !== "pdpp.conformance-report/1")
      gaps.push("Use the current upstream conformance report format.");
    if (report.base_revision !== input.base)
      gaps.push(
        "Run conformance with CONFORMANCE_BASE_REF set to the submission base commit.",
      );
    if (report.connector !== input.key)
      gaps.push("The conformance report names another connector.");
    if (report.tier !== tier)
      gaps.push(
        "The conformance report does not match the proposed listing tier.",
      );
    if (report.mode !== "full")
      gaps.push(
        "Run full conformance; the static CI report omits executable checks.",
      );
    if (
      report.subject?.revision !== input.head ||
      !report.subject.clean ||
      !report.subject.source_digest ||
      !report.subject.declaration_digest
    )
      gaps.push(
        "Run conformance on the clean final commit; its checked subject is missing, dirty or stale.",
      );
    for (const required of [
      "manifest",
      "tests",
      "pilot fixture",
      "evidence",
      "coverage",
      "shared helpers",
      "semantics",
      "mock mutation",
    ])
      if (!report.steps.some((step) => step.name === required))
        gaps.push(`The full conformance report is missing ${required}.`);
    for (const step of report.steps) {
      if (step.required_for_review === undefined)
        gaps.push(
          `The report does not identify the review requirement for ${step.name}.`,
        );
      if (step.verdict === "PASS") continue;
      if (
        step.required_for_review ||
        (step.verdict === "FAIL" && !step.advisory)
      )
        gaps.push(`Upstream ${step.name} must pass for the proposed tier.`);
      else if (!dispositions[step.name])
        gaps.push(`Explain the open upstream ${step.name} finding.`);
    }
    for (const key of Object.keys(dispositions))
      if (
        !report.steps.some(
          (step) => step.name === key && step.verdict !== "PASS",
        )
      )
        gaps.push(`Remove the stale disposition for ${key}.`);
  }
  const account = accountEvidence(
    input.key,
    input.head,
    report,
    input.claimText,
  );
  if (
    report?.steps.find((step) => step.name === "evidence")?.verdict ===
      "PASS" &&
    account.status !== "bound"
  )
    gaps.push(
      "The reported evidence pass does not match a bound public replay claim in this commit.",
    );
  return { tier, ready: gaps.length === 0, gaps, accountEvidence: account };
}
