import {
  AdapterError,
  messages,
  protocolError,
  resolveExecutable,
  invoke,
} from "../core/factory-transport.js";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { CliExitCode } from "../core/exit-codes.js";
import { getVanaHome } from "../core/paths.js";
import { readLocalProfile } from "../pdpp/local.js";
import { CONNECTOR_BUILD_INSTRUCTIONS } from "./connector-build-instructions.js";

const MAX_RESULT_BYTES = 256 * 1024;
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const text = z
  .string()
  .min(1)
  .max(4000)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const absolute = text.refine(path.isAbsolute);
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const checkName = z.enum([
  "format",
  "typecheck",
  "lint",
  "tests",
  "conformance",
  "startup-smoke",
  "connector-lint",
  "manifest-context",
]);
const checkNames = [
  "format",
  "typecheck",
  "lint",
  "tests",
  "conformance",
  "startup-smoke",
  "connector-lint",
];
const capabilitiesSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("factory_capabilities"),
    packageVersion: text,
    protocolVersion: z.literal(1),
    contextVersion: z.literal(2),
    apiPreparationVersion: z.literal(1),
    collectionVerificationVersion: z.literal(1).optional(),
    orderedTranscriptVersion: z.literal(1).optional(),
    cancellation: z.literal(true),
    nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    platform: z.enum([
      "darwin",
      "linux",
      "win32",
      "aix",
      "freebsd",
      "openbsd",
      "sunos",
      "android",
      "haiku",
      "cygwin",
      "netbsd",
    ]),
    supported: z.boolean(),
    supportedRoutes: z.tuple([z.literal("export"), z.literal("api")]),
  })
  .strict();
const errorSchema = z
  .object({
    version: z.literal(1),
    error: z
      .object({
        code: z.enum([
          "invalid_arguments",
          "invalid_request",
          "operation_locked",
          "operation_failed",
          "unsupported_runtime",
          "interrupted",
        ]),
        message: text,
      })
      .strict(),
  })
  .strict();
const accessSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("export"),
      inputEnvironmentName: environmentName,
    })
    .strict(),
  z
    .object({
      kind: z.literal("api"),
      authEnvironmentNames: z.array(environmentName).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser"),
      credentialReferences: z.array(environmentName).max(100),
    })
    .strict(),
]);
const collectionContextSchema = z
  .object({
    checkout: absolute,
    directoryKey: key,
    requestedStreams: z
      .array(key)
      .min(1)
      .max(100)
      .refine((items) => new Set(items).size === items.length),
    access: accessSchema,
  })
  .strict();
const baseJob = z.object({
  version: z.literal(1),
  id: uuid,
  sourceId: key,
  connectorDirectory: absolute,
  manifestConnectorKey: key,
  workFile: absolute,
  stateDirectory: absolute,
  collectionContext: collectionContextSchema,
});
const jobSchema = z.discriminatedUnion("status", [
  baseJob
    .extend({
      status: z.literal("agent_work"),
      reason: z.enum(["build", "prepare", "inputs_changed", "interrupted"]),
      interrupted: z.literal(true).optional(),
    })
    .strict(),
  baseJob
    .extend({
      status: z.literal("human_prerequisite"),
      requirements: z.array(text).min(1).max(100),
    })
    .strict(),
  baseJob
    .extend({ status: z.literal("blocked"), code: key, detail: text })
    .strict(),
  baseJob
    .extend({
      status: z.literal("checks_failed"),
      findings: z
        .array(
          z
            .object({
              name: checkName,
              exitCode: z.number().int().nullable(),
              logFile: absolute,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  baseJob
    .extend({
      status: z.literal("checks_passed"),
      evidence: z
        .object({
          runId: uuid,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          checkedAt: text.refine((value) => Number.isFinite(Date.parse(value))),
          checks: z
            .array(checkName)
            .refine(
              (items) => JSON.stringify(items) === JSON.stringify(checkNames),
            ),
          scope: z.literal("static_and_fixture"),
        })
        .strict(),
      liveVerification: z.literal("pending"),
      ingestion: z.literal("not_run"),
    })
    .strict(),
]);
type Job = z.infer<typeof jobSchema>;
type Operation = "build" | "prepare" | "check" | "resume";
type BuildOptions = {
  instructions?: boolean;
  request?: string;
  job?: string;
  stateDir?: string;
};
type GlobalOptions = { json?: boolean; quiet?: boolean; detach?: boolean };
type Action = { argv: string[]; requiredEnvironmentNames?: string[] };
function compatibleKeys(directory: string, manifest: string): boolean {
  return directory.replace(/_/g, "-") === manifest.replace(/_/g, "-");
}
function shellArg(value: string): string {
  return /^[a-zA-Z0-9_./:=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}
function followups(job: Job, collectionReady: boolean): Record<string, Action> {
  const sameJob = ["--job", job.id, "--state-dir", job.stateDirectory];
  return {
    check: { argv: ["vana", "connectors", "check", ...sameJob, "--json"] },
    resume: { argv: ["vana", "connectors", "resume", ...sameJob, "--json"] },
    ...(job.collectionContext.access.kind === "api"
      ? {
          prepare: {
            argv: ["vana", "connectors", "prepare", ...sameJob, "--json"],
          },
        }
      : {}),
    ...(collectionReady
      ? {
          connect: {
            argv: [
              "vana",
              "connect",
              job.collectionContext.directoryKey,
              "--from",
              job.collectionContext.checkout,
              "--streams",
              job.collectionContext.requestedStreams.join(","),
              "--factory-job",
              job.id,
              "--factory-state-dir",
              job.stateDirectory,
            ],
            requiredEnvironmentNames:
              job.collectionContext.access.kind === "export"
                ? [job.collectionContext.access.inputEnvironmentName]
                : job.collectionContext.access.kind === "api"
                  ? job.collectionContext.access.authEnvironmentNames
                  : job.collectionContext.access.credentialReferences,
          },
        }
      : {}),
  };
}
function coreError(value: unknown, exitCode: number | null): void {
  const parsed = errorSchema.safeParse(value);
  if (!parsed.success) return;
  const code = parsed.data.error.code;
  const usage = code === "invalid_arguments" || code === "invalid_request";
  if (exitCode !== (usage ? 2 : 1)) throw protocolError();
  throw new AdapterError(
    code,
    messages[code],
    usage ? CliExitCode.USAGE : CliExitCode.FAILURE,
  );
}
async function requestIdentity(file: string) {
  try {
    const fileHandle = await open(file, "r");
    let requestBytes: Buffer;
    try {
      const fileStat = await fileHandle.stat();
      if (!fileStat.isFile() || fileStat.size > MAX_RESULT_BYTES)
        throw new Error();
      const buffer = Buffer.alloc(MAX_RESULT_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await fileHandle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_RESULT_BYTES) throw new Error();
      requestBytes = buffer.subarray(0, total);
    } finally {
      await fileHandle.close();
    }
    const raw: unknown = JSON.parse(requestBytes.toString("utf8"));
    const identity = z
      .object({
        connectorDirectory: key,
        manifestConnectorKey: key,
        checkout: absolute,
        source: z.object({
          id: key,
          access: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("export"), inputEnv: environmentName }),
            z.object({
              kind: z.literal("api"),
              authEnvironmentNames: z.array(environmentName).max(100),
            }),
            z.object({
              kind: z.literal("browser"),
              credentialReferences: z.array(environmentName).max(100),
            }),
          ]),
        }),
        goal: z.object({
          streams: z
            .array(z.object({ name: key }))
            .min(1)
            .max(100),
        }),
      })
      .parse(raw);
    if (
      !compatibleKeys(
        identity.connectorDirectory,
        identity.manifestConnectorKey,
      )
    )
      throw new Error();
    return {
      requestBytes,
      sourceId: identity.source.id,
      manifestConnectorKey: identity.manifestConnectorKey,
      collectionContext: {
        checkout: await realpath(identity.checkout),
        directoryKey: identity.connectorDirectory,
        requestedStreams: identity.goal.streams.map((stream) => stream.name),
        access:
          identity.source.access.kind === "export"
            ? {
                kind: "export",
                inputEnvironmentName: identity.source.access.inputEnv,
              }
            : identity.source.access.kind === "api"
              ? {
                  kind: "api",
                  authEnvironmentNames:
                    identity.source.access.authEnvironmentNames,
                }
              : {
                  kind: "browser",
                  credentialReferences:
                    identity.source.access.credentialReferences,
                },
      },
    };
  } catch {
    throw new AdapterError(
      "invalid_request",
      "Use a readable version 1 request JSON file with lowercase connectorDirectory and manifestConnectorKey values that match after replacing underscores with hyphens. See vana connectors build --instructions.",
      CliExitCode.USAGE,
    );
  }
}
async function validateCollectionHandoff(
  job: Job,
): Promise<AdapterError | undefined> {
  if (job.status !== "checks_passed") return;
  try {
    const { profile } = await readLocalProfile(
      job.collectionContext.checkout,
      job.collectionContext.directoryKey,
    );
    if (
      profile.connector_key !== job.manifestConnectorKey ||
      !job.collectionContext.requestedStreams.every((name) =>
        profile.streams.some((stream) => stream.name === name),
      )
    )
      throw new Error();
  } catch {
    return new AdapterError(
      "factory_local_profile_incompatible",
      "Factory passed its static checks, but Vana cannot resolve the exact local Collection Profile and requested streams. Repair its index.ts, manifest version, connector_key and streams, then check the same job again. No collection command is offered.",
    );
  }
}

function exitForJob(job: Job): CliExitCode {
  if (job.status === "human_prerequisite")
    return CliExitCode.CONFIRMATION_REQUIRED;
  if (
    job.status === "blocked" ||
    job.status === "checks_failed" ||
    (job.status === "agent_work" && job.interrupted)
  )
    return CliExitCode.FAILURE;
  return CliExitCode.OK;
}
async function run(
  operation: Operation,
  options: BuildOptions,
  globals: GlobalOptions,
): Promise<CliExitCode> {
  try {
    if (globals.detach)
      throw new AdapterError(
        "invalid_arguments",
        "Connector build jobs do not support --detach. Run the explicit command in the foreground.",
        CliExitCode.USAGE,
      );
    if (operation === "build" && options.instructions && options.request)
      throw new AdapterError(
        "invalid_arguments",
        "Choose --instructions or --request, not both.",
        CliExitCode.USAGE,
      );
    if (operation === "build" && (options.instructions || !options.request)) {
      process.stdout.write(
        globals.json
          ? `${JSON.stringify({ version: 1, kind: "connector_build_instructions", instructions: CONNECTOR_BUILD_INSTRUCTIONS })}\n`
          : CONNECTOR_BUILD_INSTRUCTIONS,
      );
      return CliExitCode.OK;
    }
    if (operation !== "build" && !uuid.safeParse(options.job).success)
      throw new AdapterError(
        "invalid_arguments",
        "Provide the explicit UUID with --job. See vana connectors build --instructions.",
        CliExitCode.USAGE,
      );
    const identity =
      operation === "build"
        ? await requestIdentity(options.request!)
        : undefined;
    const executable = await resolveExecutable();
    const probe = await invoke(executable, ["capabilities", "--json"], true);
    coreError(probe.value, probe.exitCode);
    const capabilities = capabilitiesSchema.safeParse(probe.value);
    if (probe.interrupted)
      throw new AdapterError("interrupted", messages.interrupted);
    if (
      z.object({ contextVersion: z.literal(1) }).safeParse(probe.value).success
    )
      throw new AdapterError(
        "factory_context_incompatible",
        "This Factory exposes collection context version 1. Install a Factory with contextVersion 2 and apiPreparationVersion 1 before creating or modifying jobs. See vana connectors build --instructions.",
      );
    if (!capabilities.success || probe.exitCode !== 0) throw protocolError();
    if (
      !capabilities.data.supported ||
      !["darwin", "linux"].includes(capabilities.data.platform) ||
      Number(capabilities.data.nodeVersion.slice(1).split(".")[0]) < 24
    )
      throw new AdapterError(
        "unsupported_runtime",
        messages.unsupported_runtime,
      );
    const stateDirectory = path.resolve(
      options.stateDir ?? path.join(getVanaHome(), "factory"),
    );
    let requestDirectory: string | undefined;
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      let stagedRequest: string | undefined;
      if (identity) {
        requestDirectory = await mkdtemp(
          path.join(os.tmpdir(), "vana-factory-request-"),
        );
        stagedRequest = path.join(requestDirectory, "request.json");
        await writeFile(stagedRequest, identity.requestBytes, { mode: 0o600 });
      }
      result = await invoke(
        executable,
        [
          operation,
          ...(operation === "build"
            ? ["--request", stagedRequest!, "--caller", "vana"]
            : ["--job", options.job!]),
          "--state-dir",
          stateDirectory,
          "--json",
        ],
        Boolean(globals.quiet),
      );
    } finally {
      if (requestDirectory)
        await rm(requestDirectory, { recursive: true, force: true });
    }
    coreError(result.value, result.exitCode);
    const parsed = jobSchema.safeParse(result.value);
    if (!parsed.success) throw protocolError();
    const job = parsed.data;
    const canonicalStateDirectory = await realpath(stateDirectory).catch(
      () => undefined,
    );
    if (job.stateDirectory !== canonicalStateDirectory) throw protocolError();
    if (
      !compatibleKeys(
        job.collectionContext.directoryKey,
        job.manifestConnectorKey,
      ) ||
      path.normalize(job.connectorDirectory) !==
        path.join(
          job.collectionContext.checkout,
          "connectors",
          job.collectionContext.directoryKey,
        ) ||
      (options.job && job.id !== options.job) ||
      (identity &&
        (identity.sourceId !== job.sourceId ||
          identity.manifestConnectorKey !== job.manifestConnectorKey ||
          JSON.stringify(identity.collectionContext) !==
            JSON.stringify(job.collectionContext))) ||
      (job.status === "agent_work" &&
        job.interrupted &&
        job.reason !== "interrupted")
    )
      throw protocolError();
    const expectedCoreExit =
      job.status === "checks_failed" ||
      job.status === "blocked" ||
      (job.status === "agent_work" && job.interrupted)
        ? 1
        : 0;
    if (
      result.exitCode !== expectedCoreExit ||
      (result.interrupted && !(job.status === "agent_work" && job.interrupted))
    )
      throw protocolError();
    const handoffError = await validateCollectionHandoff(job);
    const actions = followups(
      job,
      job.status === "checks_passed" && !handoffError,
    );
    const output = {
      ...job,
      ...(job.status === "human_prerequisite"
        ? { requirements: undefined, requirementCount: job.requirements.length }
        : {}),
      ...(job.status === "blocked" ? { detail: undefined } : {}),
      actions,
      ...(handoffError
        ? { error: { code: handoffError.code, message: handoffError.message } }
        : {}),
    };
    if (globals.json) process.stdout.write(`${JSON.stringify(output)}\n`);
    else {
      process.stdout.write(
        `Factory job ${job.id}: ${job.status}\nWork instructions: ${job.workFile}\n`,
      );
      if (job.status === "human_prerequisite")
        process.stdout.write(
          "A person must supply the prerequisites described in the private work file.\n",
        );
      if (job.status === "checks_passed")
        process.stdout.write(
          "Static and fixture checks passed. The explicit connect action verifies its actual run before local save and ingestion. Server readback is not performed.\n",
        );
      if (handoffError) process.stderr.write(`${handoffError.message}\n`);
      for (const [name, action] of Object.entries(actions)) {
        process.stdout.write(
          `${name}: ${action.argv.map(shellArg).join(" ")}\n`,
        );
        if (action.requiredEnvironmentNames?.length)
          process.stdout.write(
            `Required environment names: ${action.requiredEnvironmentNames.join(", ")}\n`,
          );
      }
    }
    return handoffError ? CliExitCode.FAILURE : exitForJob(job);
  } catch (error) {
    const failure =
      error instanceof AdapterError
        ? error
        : new AdapterError(
            "factory_operation_failed",
            "The local Factory adapter could not complete the operation. See vana connectors build --instructions.",
          );
    const output = {
      version: 1,
      error: { code: failure.code, message: failure.message },
      remedy: { argv: ["vana", "connectors", "build", "--instructions"] },
    };
    if (globals.json) process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stderr.write(`${failure.message}\n`);
    return failure.exitCode;
  }
}

/** Register the current-agent Factory workflow beside local connector registration. */
export function registerConnectorBuildCommands(
  parent: Command,
  getOptions: () => GlobalOptions,
): void {
  parent
    .command("build")
    .description(
      "Prepare work instructions for the current agent with shared Factory checks",
    )
    .option("--instructions", "Print offline build instructions")
    .option("--request <file>", "Version 1 Factory request JSON file")
    .option("--state-dir <directory>", "Dedicated Factory job state directory")
    .action(async (options: BuildOptions) => {
      process.exitCode = await run("build", options, getOptions());
    });
  for (const operation of ["prepare", "check", "resume"] as const) {
    parent
      .command(operation)
      .description(
        operation === "prepare"
          ? "Prepare declared API evidence for an explicit connector job"
          : operation === "check"
            ? "Run Factory checks for an explicit connector job"
            : "Refresh work instructions for an explicit connector job",
      )
      .option("--job <uuid>", "Explicit Factory job UUID")
      .option(
        "--state-dir <directory>",
        "Dedicated Factory job state directory",
      )
      .action(async (options: BuildOptions) => {
        process.exitCode = await run(operation, options, getOptions());
      });
  }
}
