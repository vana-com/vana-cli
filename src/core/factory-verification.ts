import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
export const factoryContextSchema = z
  .object({
    owner: z
      .object({
        accountUrl: z.string().min(1),
        address: z.string().regex(/^0x[a-f0-9]{40}$/i),
      })
      .strict()
      .nullable(),
    destination: z
      .object({
        url: z.string().min(1),
        owner: z
          .string()
          .regex(/^0x[a-f0-9]{40}$/i)
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** A same-run protocol receipt. Local coordination, with no server readback claim. */
export const factoryVerificationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("factory_collection_verified"),
    status: z.literal("verified"),
    receiptId: uuid,
    jobId: uuid,
    attemptId: uuid,
    runId: z.string().regex(/^vana-[a-z0-9_-]+$/),
    sourceKey: key,
    manifestConnectorKey: key,
    requestedStreams: z
      .array(key)
      .min(1)
      .max(100)
      .refine((x) => new Set(x).size === x.length),
    staticRunId: uuid,
    staticFingerprint: hash,
    contextHash: hash,
    manifestSha256: hash,
    startSha256: hash,
    hostSha256: hash,
    evidenceSha256: hash,
    projectionSha256: hash,
    resultSha256: hash,
    context: factoryContextSchema,
    verifierVersion: z.literal(1),
    scope: z.literal("same_vana_run_protocol"),
    schemaValidation: z.literal("collection-profile-subset-v1"),
    ingestion: z.literal("not_run"),
    readback: z.literal("not_performed"),
  })
  .strict();
export type FactoryVerification = z.infer<typeof factoryVerificationSchema>;
