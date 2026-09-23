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
import { resolveLocalLaunch } from "./local.js";
import { findPdppPin } from "./pins.js";
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
  mergeRun,
  projectResult,
  readCollectionState,
  writeCollectionState,
  writeResult,
} from "./store.js";

/** The range every published artifact declares today; checked again per artifact. */
const EXPECTED_NODE_RANGE = ">=24.15.0 <25";

export interface PdppRuntimeOptions {
  /** A data-connectors checkout to run the connector from, instead of an artifact. */
  from?: string;
  /** Owner of the Personal Server the data goes to; state is kept per owner. */
  owner?: string | null;
}

export function isPdppSource(
  source: string,
  options: PdppRuntimeOptions = {},
): boolean {
  return Boolean(options.from) || findPdppPin(source) !== null;
}

/**
 * Runs Collection Profile connectors behind the same interface as the
 * managed Playwright runtime, so `vana connect` keeps one flow, one set of
 * prompts and one stream of JSON events for both connector formats.
 */
export class PdppRuntime {
  readonly kind = "pdpp" as const;
  private launch: PdppLaunch | null = null;
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
  }> {
    const logPath = getTimestampedLogPath(`fetch-${source}`);
    await ensureParentDir(logPath);
    await fsp.writeFile(logPath, "", "utf8");
    try {
      if (this.options.from) {
        this.launch = await resolveLocalLaunch(this.options.from, source);
      } else {
        const pin = findPdppPin(source);
        if (!pin) {
          throw new Error(
            `No Collection Profile connector is pinned for ${source}.`,
          );
        }
        this.launch = await ensurePinnedArtifact(pin, logPath);
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
      `${JSON.stringify({ type: "connector-resolved", source, origin: this.launch.origin, version: this.launch.version })}\n`,
      "utf8",
    );
    return {
      connectorPath: this.launch.args[this.launch.args.length - 1],
      logPath,
      version: this.launch.version,
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
    const logStream = fs.createWriteStream(logPath);
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
        const message = error instanceof Error ? error.message : String(error);
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

    const statePath = collectionStatePath(source, this.options.owner);
    const previous = await readCollectionState(statePath);
    const streamNames = launch.profile.streams.map((stream) => stream.name);
    const mode = launch.profile.streams.some(
      (stream) => stream.incremental === false,
    )
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

    const outcome = await runCollectionProfile({
      node: node.path,
      args: launch.args,
      cwd: launch.cwd,
      env,
      signal: options.signal,
      start: {
        type: "START",
        run_id: runId,
        collection_mode: mode,
        scope: { streams: streamNames.map((name) => ({ name })) },
        state: previous.checkpoints,
      },
      log,
      onRecord: (record) => {
        records.push(record);
        counts.set(record.stream, (counts.get(record.stream) ?? 0) + 1);
        if (activeStream !== record.stream) enterStream(record.stream);
      },
      onState: (stream, cursor) => {
        checkpoints[stream] = cursor;
      },
      onProgress: (progress) => {
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
      onSkip: (skip) => {
        skips.push(skip);
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
    const merged = mergeRun(previous, {
      mode,
      completed,
      records,
      checkpoints,
    });
    const resultPath = getSourceResultPath(source);
    await writeResult(
      resultPath,
      projectResult(source, launch.displayName, merged, completed),
    );
    // State is committed only once the result it describes is on disk, so a
    // crash in between re-collects rather than skipping data.
    await writeCollectionState(statePath, merged);
    push({ type: "collection-complete", source, resultPath, logPath });
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
