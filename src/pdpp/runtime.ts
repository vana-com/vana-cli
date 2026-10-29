import {
  FactoryCollectionGate,
  FactoryCollectionFailure,
  type FactoryBindingOptions,
} from "./factory-gate.js";
import { exportDigest } from "../core/source-export.js";
import type { FactoryVerification } from "../core/factory-verification.js";
import type { z } from "zod";
import type { factoryContextSchema } from "../core/factory-verification.js";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  ensureParentDir,
  getLogsDir,
  getSourceResultPath,
  getTimestampedLogPath,
} from "../core/index.js";
import type { CliEvent, RuntimeState } from "../core/cli-types.js";
import type { RunConnectorOptions } from "../runtime/managed-playwright.js";
import {
  browserEnvironment,
  canInstallNodeFor,
  ensureConnectorBrowser,
  findCompatibleNode,
  findCompatibleNodeSync,
  getPdppHome,
  getPdppProfileRoot,
  installManagedNode,
  linkHostPackages,
  PDPP_NODE_VERSION,
} from "./host.js";
import { ensurePinnedArtifact } from "./installer.js";
import { findLocalConnectorFiles, resolveLocalLaunch } from "./local.js";
import {
  resolvePdppSource,
  type LocalConnectorDeps,
} from "./local-connectors.js";
import type { PdppLaunch } from "./profile.js";
import {
  runCollectionProfile,
  type ConnectorRecord,
  type InteractionReply,
  type InteractionRequest,
  type SkipResult,
} from "./protocol.js";
import {
  collectionStatePath,
  completedStreams,
  describeSkips,
  mergeRun,
  projectResult,
  readCollectionState,
  writeCollectionState,
  writeResult,
  withCollectionLock,
} from "./store.js";

/** The range every published artifact declares today; checked again per artifact. */
const EXPECTED_NODE_RANGE = ">=24.15.0 <25";

export interface PdppRuntimeOptions {
  factory?: FactoryBindingOptions;
  collectionContext?: z.infer<typeof factoryContextSchema>;
  /** A data-connectors checkout to run the connector from, instead of an artifact. */
  from?: string;
  /** Limit collection and publication to these declared stream names. */
  streams?: readonly string[];
  /** Owner of the Personal Server the data goes to; state is kept per owner. */
  owner?: string | null;
  /** How saved local connectors are looked up; tests inject their own. */
  deps?: Partial<LocalConnectorDeps>;
}

/**
 * Runs Collection Profile connectors behind the same interface as the
 * managed Playwright runtime, so `vana connect` keeps one flow, one set of
 * prompts and one stream of JSON events for both connector formats.
 */
export class PdppRuntime {
  readonly kind = "pdpp" as const;
  private launch: PdppLaunch | null = null;
  private localPath: string | null = null;
  private cachedState: RuntimeState | null = null;

  constructor(private readonly options: PdppRuntimeOptions = {}) {}

  get installSummary(): { lines: string[]; phase: string } {
    return {
      lines: [
        `Node.js ${PDPP_NODE_VERSION}, the runtime these connectors need`,
      ],
      phase: `Installing Node.js ${PDPP_NODE_VERSION} (one time, ~50MB)`,
    };
  }

  get state(): RuntimeState {
    this.cachedState ??= findCompatibleNodeSync(EXPECTED_NODE_RANGE)
      ? "installed"
      : "missing";
    return this.cachedState;
  }

  async ensureInstalled(_autoApprove: boolean): Promise<{
    runtime: RuntimeState;
    runtimePath: string | null;
    logPath?: string;
  }> {
    const existing = await findCompatibleNode(EXPECTED_NODE_RANGE);
    if (existing) {
      this.cachedState = "installed";
      return { runtime: "installed", runtimePath: existing.path };
    }
    const logPath = getTimestampedLogPath("setup-pdpp");
    await ensureParentDir(logPath);
    if (!canInstallNodeFor(EXPECTED_NODE_RANGE)) {
      throw new Error(
        `These connectors need Node ${EXPECTED_NODE_RANGE}. Install it and set VANA_PDPP_NODE to its path.`,
      );
    }
    const node = await installManagedNode(logPath);
    this.cachedState = "installed";
    return { runtime: "installed", runtimePath: node.path, logPath };
  }

  async fetchConnector(
    source: string,
    _currentVersion?: string,
  ): Promise<{
    connectorPath: string;
    logPath: string;
    version?: string;
    exportFrequency?: string;
    updated?: boolean;
    previousVersion?: string;
    /** The directory unsigned source runs from; absent for a pinned artifact. */
    localPath?: string;
  }> {
    const logPath = getTimestampedLogPath(`fetch-${source}`);
    await ensureParentDir(logPath);
    await fsp.writeFile(logPath, "", "utf8");
    try {
      const resolved = await resolvePdppSource(
        source,
        { from: this.options.from },
        this.options.deps,
      );
      if (!resolved) {
        throw new Error(
          `No Collection Profile connector is pinned or registered for ${source}. Run \`vana connectors add ${source} --from <dir>\` to use a local one.`,
        );
      }
      if (resolved.kind === "pinned") {
        this.launch = await ensurePinnedArtifact(resolved.pin, logPath);
      } else {
        this.launch = await resolveLocalLaunch(resolved.path, source);
        this.localPath = resolved.path;
      }
      if (this.options.streams !== undefined) {
        const requested = new Set(this.options.streams);
        const declared = new Set(
          this.launch.profile.streams.map((stream) => stream.name),
        );
        if (
          !requested.size ||
          [...requested].some((name) => !declared.has(name))
        ) {
          throw new Error(
            `Select one or more declared streams: ${[...declared].join(", ")}`,
          );
        }
      }
    } catch (error) {
      await fsp.appendFile(
        logPath,
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        "utf8",
      );
      if (error && typeof error === "object") Object.assign(error, { logPath });
      throw error;
    }
    await fsp.appendFile(
      logPath,
      `${JSON.stringify({ type: "connector-resolved", source, origin: this.launch.origin, version: this.launch.version, ...(this.localPath ? { localPath: this.localPath } : {}) })}\n`,
      "utf8",
    );
    return {
      connectorPath: this.launch.args[this.launch.args.length - 1],
      logPath,
      version: this.launch.version,
      ...(this.localPath ? { localPath: this.localPath } : {}),
    };
  }

  async *runConnector(
    options: RunConnectorOptions,
  ): AsyncGenerator<CliEvent, void, void> {
    const launch = this.launch;
    if (!launch) {
      throw new Error("fetchConnector must run before runConnector.");
    }
    await fsp.mkdir(getLogsDir(), { recursive: true });
    const logPath = getTimestampedLogPath(`run-${options.source}`);
    const logStream = fs.createWriteStream(logPath, { mode: 0o600 });
    const log = (line: string) => logStream.write(`${line}\n`);

    const queue: CliEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: CliEvent) => {
      queue.push(event);
      wake?.();
      wake = null;
    };

    const run = this.execute(launch, options, logPath, log, push).catch(
      (error: unknown) => {
        const message = this.options.factory
          ? error instanceof FactoryCollectionFailure
            ? error.message
            : "Factory collection failed. Previous data and checkpoints were kept; inspect the private attempt evidence."
          : error instanceof Error
            ? error.message
            : String(error);
        log(`[host] ${message}`);
        push({
          type: "runtime-error",
          source: options.source,
          message,
          logPath,
        });
      },
    );
    let settled = false;
    void run.finally(() => {
      settled = true;
      wake?.();
      wake = null;
    });

    push({ type: "run-started", source: options.source, logPath });
    // Local source is unsigned and unverified, so every run says where it
    // came from, in the log and in the event stream alike.
    if (this.localPath) {
      log(`[host] running ${launch.source} from ${this.localPath}`);
      push({
        type: "local-connector",
        source: options.source,
        connectorPath: this.localPath,
        message: `Running ${launch.source} from ${this.localPath}`,
        logPath,
      });
    }
    try {
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
        }
        if (settled) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      await new Promise<void>((resolve) => logStream.end(resolve));
    }
  }

  private async execute(
    launch: PdppLaunch,
    options: RunConnectorOptions,
    logPath: string,
    log: (line: string) => void,
    push: (event: CliEvent) => void,
  ): Promise<void> {
    const owner =
      this.options.factory && this.options.collectionContext?.owner
        ? `${this.options.collectionContext.owner.accountUrl}#${this.options.collectionContext.owner.address}`
        : this.options.owner;
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      return await withCollectionLock(
        collectionStatePath(launch.source, owner),
        () =>
          this.executeLocked(
            launch,
            { ...options, signal },
            logPath,
            log,
            push,
            owner,
          ),
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  private async executeLocked(
    launch: PdppLaunch,
    options: RunConnectorOptions,
    logPath: string,
    log: (line: string) => void,
    push: (event: CliEvent) => void,
    stateOwner?: string | null,
  ): Promise<void> {
    const source = launch.source;
    const node = await findCompatibleNode(launch.nodeRange);
    if (!node) {
      throw new Error(
        `The ${launch.displayName} connector needs Node ${launch.nodeRange}, and none was found. Set VANA_PDPP_NODE to a Node binary in that range.`,
      );
    }
    log(`[host] node ${node.version} at ${node.path}`);
    if (launch.installRoot) {
      await linkHostPackages(launch.installRoot, {
        node: launch.nodeRange,
        packages: launch.hostPackages,
      });
    }
    if (launch.profile.runtime_requirements?.bindings?.browser?.required) {
      await ensureConnectorBrowser(node, logPath);
    }

    const statePath = collectionStatePath(source, stateOwner);
    const previous = await readCollectionState(statePath);
    const selectedStreams =
      this.options.factory && this.options.streams
        ? this.options.streams.map(
            (name) =>
              launch.profile.streams.find((stream) => stream.name === name)!,
          )
        : launch.profile.streams.filter(
            (stream) =>
              this.options.streams === undefined ||
              this.options.streams.includes(stream.name),
          );
    const streamNames = selectedStreams.map((stream) => stream.name);
    const mode = selectedStreams.some((stream) => stream.incremental === false)
      ? "full_refresh"
      : "incremental";
    const runId = `vana-${source}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Inherit the caller's environment for PATH and locale, but never its
    // PDPP_* settings: a remote CDP URL in there would attach the connector
    // to someone's own browser, and the runtime closes every tab it finds.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("PDPP_")) env[key] = value;
    }
    Object.assign(env, browserEnvironment(), {
      PDPP_RUN_ID: runId,
      PDPP_BROWSER_PROFILE_ROOT: getPdppProfileRoot(),
      // A scheduled trigger makes connectors fail fast with a repair error
      // instead of waiting on a sign-in nobody will do.
      PDPP_RUN_TRIGGER_KIND: options.noInput ? "scheduled" : "manual",
    });

    const labels = new Map(
      launch.profile.streams.map((stream) => [
        stream.name,
        stream.display?.label ?? stream.name,
      ]),
    );
    const counts = new Map<string, number>();
    let activeStream: string | null = null;
    const finishStream = (stream: string) => {
      const count = counts.get(stream) ?? 0;
      push({
        type: "progress-update",
        source,
        logPath,
        message: `Complete: ${count} ${count === 1 ? "record" : "records"}`,
        count,
        phase: {
          step: streamNames.indexOf(stream) + 1,
          total: streamNames.length,
          label: labels.get(stream) ?? stream,
        },
      });
    };
    const enterStream = (stream: string, message?: string) => {
      if (activeStream && activeStream !== stream) finishStream(activeStream);
      activeStream = stream;
      push({
        type: "progress-update",
        source,
        logPath,
        message: message ?? `Collecting ${labels.get(stream) ?? stream}`,
        phase: {
          step: streamNames.indexOf(stream) + 1,
          total: streamNames.length,
          label: labels.get(stream) ?? stream,
        },
      });
    };

    const records: ConnectorRecord[] = [];
    const checkpoints: Record<string, Record<string, unknown>> = {};
    const skips: SkipResult[] = [];

    if (options.signal?.aborted)
      throw new Error("Cancelled before collection.");
    const exportedAt = new Date().toISOString();
    const start = {
      type: "START" as const,
      run_id: runId,
      collection_mode: mode as "incremental" | "full_refresh",
      scope: { streams: streamNames.map((name) => ({ name })) },
      state: previous.checkpoints,
    };
    let gate: FactoryCollectionGate | undefined;
    if (this.options.factory) {
      if (
        !this.options.from ||
        !this.options.streams ||
        launch.origin !== "local" ||
        !this.options.collectionContext
      )
        throw new Error(
          "Factory requires an explicit local launch, streams and collection context.",
        );
      const checkout = await fsp.realpath(this.options.from);
      const files = findLocalConnectorFiles(checkout, source);
      const manifest = await fsp.readFile(files.manifestPath);
      if (
        JSON.stringify(JSON.parse(manifest.toString("utf8"))) !==
        JSON.stringify(launch.profile)
      )
        throw new Error("Loaded manifest changed.");
      const nodePath = await fsp.realpath(node.path);
      gate = await FactoryCollectionGate.begin(
        this.options.factory,
        {
          version: 1,
          binding: {
            jobId: this.options.factory.jobId,
            sourceKey: source,
            checkout,
            connectorDirectory: path.dirname(files.entry),
            manifestConnectorKey: launch.profile.connector_key,
            requestedStreams: streamNames,
            runId,
          },
          manifestSha256: exportDigest(manifest),
          start,
          host: {
            nodePath,
            nodeSha256: exportDigest(await fsp.readFile(nodePath)),
            nodeVersion: `v${node.version}`,
            cwd: launch.cwd,
            args: launch.args,
            environmentSha256: exportDigest(
              Buffer.from(
                JSON.stringify(
                  Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
                ),
              ),
            ),
          },
          context: this.options.collectionContext,
          previous,
          displayName: launch.displayName,
          exportedAt,
        },
        options.signal,
      );
    }
    let verification: FactoryVerification | undefined;
    try {
      if (options.signal?.aborted)
        throw new Error("Cancelled before provider launch.");
      const outcome = await runCollectionProfile({
        node: node.path,
        args: launch.args,
        cwd: launch.cwd,
        env,
        signal: options.signal,
        start,
        ...(gate ? { capture: gate.capture } : {}),
        log: this.options.factory ? () => {} : log,
        onRecord: (record) => {
          records.push(record);
          counts.set(record.stream, (counts.get(record.stream) ?? 0) + 1);
          if (activeStream !== record.stream) enterStream(record.stream);
        },
        onState: (stream, cursor) => {
          checkpoints[stream] = cursor;
        },
        onProgress: (progress) => {
          if (this.options.factory) return;
          log(`[progress] ${JSON.stringify(progress)}`);
          if (progress.stream && labels.has(progress.stream)) {
            enterStream(progress.stream, progress.message);
          } else if (progress.message) {
            push({
              type: "status-update",
              source,
              logPath,
              message: progress.message,
            });
          }
        },
        onAssistance: (message) => {
          log(`[assistance] ${message}`);
          push({
            type: options.noInput ? "legacy-auth" : "headed-required",
            source,
            logPath,
            message,
          });
          if (options.noInput) {
            throw new Error(
              "Browser sign-in is required; run without --no-input.",
            );
          }
        },
        onSkip: (skip) => {
          skips.push(skip);
          if (this.options.factory) return;
          log(`[skip] ${JSON.stringify(skip)}`);
          push({
            type: "stream-skipped",
            source,
            logPath,
            stream: skip.stream,
            reason: skip.reason,
            message: skip.message ?? `Skipped ${skip.stream ?? "the run"}.`,
          });
        },
        onInteraction: (request) =>
          this.interact(request, source, options, logPath, log, push),
      });

      if (activeStream) finishStream(activeStream);
      log(`[host] outcome ${JSON.stringify(outcome)}`);

      if (gate) verification = await gate.verify();
      if (options.signal?.aborted)
        throw new Error("Cancelled before collection acceptance.");
      if (outcome.status !== "succeeded") {
        push({
          type: "runtime-error",
          source,
          logPath,
          message: outcome.error?.message ?? "The connector run failed.",
        });
        return;
      }

      const completed = completedStreams(streamNames, skips);
      if (completed.length === 0) {
        // Nothing this run collected can be stood behind. Writing a result
        // anyway would replace the last good one with bare metadata, and the
        // ingest step would store that metadata as scopes. The previous state
        // and result stay exactly as they were.
        push({
          type: "runtime-error",
          source,
          logPath,
          message: `No ${launch.displayName} stream finished, so nothing was saved. ${describeSkips(skips)}`,
        });
        return;
      }
      const merged = mergeRun(previous, {
        mode,
        completed,
        records,
        checkpoints,
      });
      const resultPath = options.resultPath ?? getSourceResultPath(source);
      const result = projectResult(
        source,
        launch.displayName,
        merged,
        completed,
        exportedAt,
      );
      if (verification) {
        const digest = (v: unknown) =>
          exportDigest(Buffer.from(JSON.stringify(v)));
        const normalizedRecords = records.map((r) => ({
          ...r,
          op: r.op ?? "upsert",
        }));
        if (
          verification.runId !== runId ||
          verification.sourceKey !== source ||
          verification.jobId !== this.options.factory?.jobId ||
          JSON.stringify(verification.requestedStreams) !==
            JSON.stringify(streamNames) ||
          verification.projectionSha256 !==
            digest({ records: normalizedRecords, checkpoints }) ||
          verification.resultSha256 !==
            exportDigest(Buffer.from(`${JSON.stringify(result, null, 2)}\n`)) ||
          JSON.stringify(verification.context) !==
            JSON.stringify(this.options.collectionContext)
        )
          throw new Error("Factory accepted-byte binding mismatch.");
      }
      if (options.signal?.aborted)
        throw new Error("Cancelled before local save.");
      await writeResult(resultPath, result);
      // State is committed only once the result it describes is on disk, so a
      // crash in between re-collects rather than skipping data.
      await writeCollectionState(statePath, merged);
      push({
        type: "collection-complete",
        source,
        resultPath,
        logPath,
        ...(verification ? { factoryVerification: verification } : {}),
      });
    } finally {
      gate?.close();
    }
  }

  private async interact(
    request: InteractionRequest,
    source: string,
    options: RunConnectorOptions,
    logPath: string,
    log: (line: string) => void,
    push: (event: CliEvent) => void,
  ): Promise<InteractionReply> {
    log(`[interaction] ${request.kind}: ${request.message}`);
    const manual = request.kind === "manual_action";
    const fields = manual ? [] : Object.keys(request.schema?.properties ?? {});

    if (options.noInput) {
      push(
        manual
          ? {
              type: "legacy-auth",
              source,
              logPath,
              message:
                "This source needs you to sign in in a browser window, which --no-input does not allow.",
            }
          : {
              type: "needs-input",
              source,
              logPath,
              message: request.message,
              fields,
            },
      );
      return {
        status: "cancelled",
        message: "Input is disabled for this run.",
      };
    }

    if (manual) {
      push({
        type: "headed-required",
        source,
        logPath,
        message: request.message,
      });
    }

    const pendingInputPath = path.join(
      getPdppHome(),
      `pending-input-${request.requestId}.json`,
    );
    const responseInputPath = path.join(
      getPdppHome(),
      `input-response-${request.requestId}.json`,
    );

    if (options.onNeedInput) {
      const values = await options.onNeedInput({
        message: request.message,
        schema: request.schema,
        fields,
        responseInputPath,
        kind: request.kind,
      });
      return {
        status: "success",
        ...(fields.length > 0 ? { data: values } : {}),
      };
    }

    // IPC: an agent reads the pending file and answers in the response file.
    // A manual step is confirmed with `{}` once the person has signed in, or
    // declined with `{"status":"cancelled"}`.
    await ensureParentDir(pendingInputPath);
    await fsp.writeFile(
      pendingInputPath,
      `${JSON.stringify(
        {
          kind: request.kind,
          message: request.message,
          schema: request.schema ?? {},
          responseInputPath,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    push({
      type: "needs-input",
      source,
      logPath,
      message: request.message,
      fields,
      reason: request.kind,
      pendingInputPath,
      responseInputPath,
    });
    try {
      const deadline = Date.now() + request.timeoutMs;
      while (Date.now() < deadline) {
        try {
          const response = JSON.parse(
            await fsp.readFile(responseInputPath, "utf8"),
          ) as Record<string, string>;
          await fsp.rm(responseInputPath, { force: true });
          if (response.status === "cancelled") {
            return { status: "cancelled", message: "Declined." };
          }
          return fields.length > 0
            ? { status: "success", data: response }
            : { status: "success" };
        } catch {
          // Not answered yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { status: "cancelled", message: "Nobody answered in time." };
    } finally {
      await fsp.rm(pendingInputPath, { force: true });
    }
  }
}
