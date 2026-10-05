import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getTelemetryOutboxDir,
  readCliConfig,
  updateCliConfig,
} from "../core/index.js";
import {
  CliOutcomeStatus,
  type CliChannel,
  type CliEvent,
  type CliInstallMethod,
  type CliOutcome,
} from "../core/cli-types.js";
import {
  TELEMETRY_ENDPOINT,
  TELEMETRY_EVENT_VERSION,
  TELEMETRY_PRODUCER_NAME,
  type TelemetryArch,
  type TelemetryBatch,
  type TelemetryCancellationReason,
  type TelemetryCorrelation,
  type TelemetryErrorClass,
  type TelemetryEvent,
  type TelemetryInteractionKind,
  type TelemetryKind,
  type TelemetryOs,
} from "./telemetry-contract.js";

// ── Config ──────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_BATCH = 100;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_FILES_PER_FLUSH = 10;
const FLUSH_TIMEOUT_MS = 1500;

// ── Command context ─────────────────────────────────────────────────────────
//
// Each CLI invocation passes one context through to createCliTelemetrySession.
// The session owns a hostRunId for the invocation and a (possibly many)
// collectionRunId(s) as collection lifecycle events fire.

type TelemetryMode = "normal" | "disabled" | "debug" | "local_only";
type TelemetryReason =
  | "default"
  | "config_enabled"
  | "config_disabled"
  | "env_disabled"
  | "env_debug"
  | "local_only";

export interface TelemetryCommandContext {
  command: string;
  subcommand?: string;
  source?: string;
  cliVersion: string;
  channel: CliChannel;
  installMethod: CliInstallMethod;
  options: {
    json: boolean;
    noInput: boolean;
    quiet: boolean;
    detach: boolean;
    ipc: boolean;
  };
  localOnly?: boolean;
}

export interface TelemetryStatus {
  enabled: boolean;
  mode: "normal" | "disabled" | "debug";
  reason: TelemetryReason;
  installId: string;
  endpoint: string;
  queuedBatches: number;
}

interface ResolvedTelemetryState {
  enabled: boolean;
  mode: TelemetryMode;
  reason: TelemetryReason;
  endpoint: string;
  installId: string;
  queuedBatches: number;
}

interface CommandResult {
  exitCode: number;
  outcome?: string | null;
  errorClass?: string | null;
}

export interface CliTelemetrySession {
  /** Translate a CLI-native event into canonical telemetry events. */
  trackCliEvent(event: CliEvent | CliOutcome): void;
  /**
   * No-op shim for call sites that emitted ad-hoc custom events. The
   * canonical contract does not support arbitrary event names; the
   * intended way to carry producer-specific detail is via
   * `extensions` on host events, already handled by the session.
   */
  trackCustomEvent(eventName: string, patch?: Record<string, unknown>): void;
  /** Mark the overall command result and emit host/collection terminals. */
  markCommandResult(result: CommandResult): void;
  /** Persist queued events to the outbox. */
  persist(): Promise<void>;
  /** Attempt to flush outbox files to the server. */
  flush(): Promise<void>;
}

let activeSession: CliTelemetrySession | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getEndpoint() {
  return process.env.VANA_TELEMETRY_URL?.trim() || TELEMETRY_ENDPOINT;
}

function detectOs(): TelemetryOs {
  const platform = process.platform;
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux"; // fallback
}

function detectArch(): TelemetryArch {
  const arch = os.arch();
  if (arch === "arm64") return "arm64";
  return "x86_64";
}

function makeHostPlatform(osName: TelemetryOs, arch: TelemetryArch) {
  return `${osName}-${arch}`;
}

// Message fragments that identify a canonical error class, first match wins.
// Earlier rows keep the precedence the CLI has always had; the rows after
// `network_error` name classes that used to fall through to `unknown`.
// e.g. "page.goto: net::ERR_NAME_NOT_RESOLVED" -> network_error
const ERROR_CLASS_PATTERNS: ReadonlyArray<[TelemetryErrorClass, RegExp]> = [
  [
    "personal_server_unavailable",
    /personal_server_unavailable|personal server/,
  ],
  ["auth_failed", /auth|legacy/],
  ["timeout", /timeout|timed out/],
  [
    "network_error",
    /network|net::err_|econnrefused|econnreset|enotfound|eai_again|socket hang up|fetch failed|could not reach|unreachable/,
  ],
  ["rate_limited", /rate.?limit|too many requests|\b429\b/],
  [
    "auth_failed",
    /\b40[13]\b|\bsign.?in\b|\blog.?in\b|credential|session expired/,
  ],
  ["upstream_error", /\b50[0-4]\b|bad gateway|service unavailable/],
  ["selector_error", /selector|locator|element (?:is )?not (?:found|visible)/],
  ["navigation_error", /navigat|page\.goto|frame was detached/],
  ["protocol_violation", /malformed|invalid (?:json|result|response)/],
  [
    "runtime_error",
    /runtime|connector|unexpected|ingest_failed|setup_required|invalid_connector|display server|browser session ended|target (?:page, context or browser has been )?closed/,
  ],
];

// Classify a free-form CLI error/reason string into a canonical error class.
// The CLI's own classification produced richer values (e.g. setup_required,
// legacy_auth); we collapse these into the canonical whitelist here.
function classifyCanonicalError(value?: string | null): TelemetryErrorClass {
  const normalized = (value ?? "").toLowerCase();
  if (!normalized) return "unknown";

  for (const [errorClass, pattern] of ERROR_CLASS_PATTERNS) {
    if (pattern.test(normalized)) return errorClass;
  }
  return "unknown";
}

// A `runtime-error` event is an exception out of the connector or its
// runtime, which is what `runtime_error` means. `unknown` is kept for runs
// that ended with nothing to classify at all.
function classifyRuntimeFailure(message?: string | null): TelemetryErrorClass {
  const errorClass = classifyCanonicalError(message);
  return errorClass === "unknown" ? "runtime_error" : errorClass;
}

// CLI outcomes that mean the connector's result was accepted as data. Sync
// can still fail afterwards; that is the sync lifecycle's to report.
const COLLECTED_OUTCOMES: ReadonlySet<string> = new Set([
  CliOutcomeStatus.CONNECTED_AND_INGESTED,
  CliOutcomeStatus.CONNECTED_LOCAL_ONLY,
  CliOutcomeStatus.INGEST_FAILED,
]);

// CLI outcomes that mean a person was asked for input and never gave it.
// The contract files these under `cancelled`, never under `failure`.
const INPUT_PENDING_OUTCOME: string = CliOutcomeStatus.NEEDS_INPUT;
const PROMPT_CANCELLED = "prompt_cancelled";

function cancellationFor(
  outcome?: string | null,
  reason?: string | null,
): TelemetryCancellationReason | null {
  if (outcome === PROMPT_CANCELLED || reason === PROMPT_CANCELLED) {
    return "user_aborted";
  }
  if (outcome === INPUT_PENDING_OUTCOME) return "abandoned";
  return null;
}

// ── Automation marker ───────────────────────────────────────────────────────
//
// Declares who is driving this invocation, so CI and agent runs can be told
// apart from a person at a terminal without guessing from install ids.

type TelemetryAutomation = "ci" | "agent" | "scripted" | "none";

const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TF_BUILD",
] as const;

const AGENT_ENV_VARS = [
  "AGENT",
  "CLAUDECODE",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "GEMINI_CLI",
] as const;

function hasEnv(names: readonly string[]) {
  return names.some((name) => Boolean(process.env[name]));
}

function detectAutomation(
  options: TelemetryCommandContext["options"],
): TelemetryAutomation {
  if (hasEnv(CI_ENV_VARS)) return "ci";
  if (hasEnv(AGENT_ENV_VARS) || options.ipc) return "agent";

  const hasTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!hasTerminal || options.noInput || options.json) return "scripted";
  return "none";
}

// Map a CLI interaction indicator to a canonical InteractionKind.
function mapInteractionKind(
  value?: string | null,
): TelemetryInteractionKind | undefined {
  const normalized = (value ?? "").toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("otp")) return "otp";
  if (normalized.includes("captcha")) return "captcha";
  if (normalized.includes("login") || normalized.includes("credential"))
    return "login";
  return "manual_action";
}

// ── Outbox (file-backed) ────────────────────────────────────────────────────
//
// Events are batched into TelemetryBatch envelopes, written to individual
// JSON files in getTelemetryOutboxDir(), and flushed on command exit and on
// subsequent runs (retry across restarts). This survives crashes — the
// pattern is worth preserving for the desktop app too.

async function ensureOutboxDir() {
  await fs.mkdir(getTelemetryOutboxDir(), { recursive: true });
}

async function listOutboxFiles() {
  try {
    const dirents = await fs.readdir(getTelemetryOutboxDir(), {
      withFileTypes: true,
    });
    return dirents
      .filter(
        (entry: { isFile(): boolean; name: string }) =>
          entry.isFile() && entry.name.endsWith(".json"),
      )
      .map((entry: { name: string }) =>
        path.join(getTelemetryOutboxDir(), entry.name),
      )
      .sort();
  } catch {
    return [];
  }
}

async function countQueuedBatches() {
  return (await listOutboxFiles()).length;
}

async function ensureTelemetryInstallId() {
  const config = await readCliConfig();
  if (config.telemetryInstallId) {
    return config.telemetryInstallId;
  }
  const installId = randomId("inst");
  await updateCliConfig({ telemetryInstallId: installId });
  return installId;
}

async function resolveTelemetryState(
  localOnly = false,
): Promise<ResolvedTelemetryState> {
  const config = await readCliConfig();
  const installId = await ensureTelemetryInstallId();
  const queuedBatches = await countQueuedBatches();

  if (localOnly) {
    return {
      enabled: false,
      mode: "local_only",
      reason: "local_only",
      endpoint: getEndpoint(),
      installId,
      queuedBatches,
    };
  }

  if (process.env.VANA_TELEMETRY_DEBUG === "1") {
    return {
      enabled: true,
      mode: "debug",
      reason: "env_debug",
      endpoint: getEndpoint(),
      installId,
      queuedBatches,
    };
  }

  if (process.env.VANA_TELEMETRY_DISABLED === "1") {
    return {
      enabled: false,
      mode: "disabled",
      reason: "env_disabled",
      endpoint: getEndpoint(),
      installId,
      queuedBatches,
    };
  }

  if (config.telemetryEnabled === false) {
    return {
      enabled: false,
      mode: "disabled",
      reason: "config_disabled",
      endpoint: getEndpoint(),
      installId,
      queuedBatches,
    };
  }

  return {
    enabled: true,
    mode: "normal",
    reason: config.telemetryEnabled ? "config_enabled" : "default",
    endpoint: getEndpoint(),
    installId,
    queuedBatches,
  };
}

// ── Event factory ───────────────────────────────────────────────────────────
//
// Builds canonical TelemetryEvent values with identity + time + attribution +
// context auto-populated. The caller supplies correlation + kind.

function createEventFactory(
  context: TelemetryCommandContext,
  state: ResolvedTelemetryState,
) {
  const hostRunId = randomId("host");
  const osName = detectOs();
  const arch = detectArch();
  const hostPlatform = makeHostPlatform(osName, arch);

  const baseContext = {
    hostPlatform,
    os: osName,
    arch,
    producerVersion: context.cliVersion,
  };

  return {
    hostRunId,
    build(args: {
      correlation: TelemetryCorrelation;
      kind: TelemetryKind;
      durationMs?: number;
      connectorVersion?: string;
      authMode?: string;
      debug?: string;
      extensions?: Record<string, unknown>;
    }): TelemetryEvent {
      return {
        identity: {
          eventId: randomId("evt"),
          eventVersion: TELEMETRY_EVENT_VERSION,
        },
        time: {
          occurredAt: nowIso(),
          ...(args.durationMs !== undefined
            ? { durationMs: args.durationMs }
            : {}),
        },
        attribution: {
          producer: TELEMETRY_PRODUCER_NAME,
          installId: state.installId,
        },
        context: {
          ...baseContext,
          ...(args.connectorVersion
            ? { connectorVersion: args.connectorVersion }
            : {}),
          ...(args.authMode ? { authMode: args.authMode } : {}),
        },
        correlation: args.correlation,
        kind: args.kind,
        ...(args.debug ? { debug: args.debug } : {}),
        ...(args.extensions ? { extensions: args.extensions } : {}),
      };
    },
  };
}

// ── Batch serialization ─────────────────────────────────────────────────────

function splitIntoEnvelopes(events: TelemetryEvent[]): TelemetryBatch[] {
  const envelopes: TelemetryBatch[] = [];
  let current: TelemetryEvent[] = [];

  const flushCurrent = () => {
    if (current.length === 0) return;
    envelopes.push({
      batchId: randomId("batch"),
      sentAt: nowIso(),
      events: current,
    });
    current = [];
  };

  for (const event of events) {
    current.push(event);
    const candidate: TelemetryBatch = {
      batchId: "batch_candidate",
      sentAt: nowIso(),
      events: current,
    };
    const tooManyEvents = current.length > MAX_EVENTS_PER_BATCH;
    const tooLarge =
      Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_BATCH_BYTES;
    if (tooManyEvents || tooLarge) {
      const overflow = current.pop();
      flushCurrent();
      if (overflow) current.push(overflow);
    }
  }

  flushCurrent();
  return envelopes;
}

async function writeEnvelope(envelope: TelemetryBatch, hostRunId: string) {
  await ensureOutboxDir();
  const filename = `${Date.now()}-${process.pid}-${hostRunId}-${crypto.randomUUID()}.json`;
  const outboxPath = path.join(getTelemetryOutboxDir(), filename);
  await fs.writeFile(outboxPath, `${JSON.stringify(envelope)}\n`, "utf8");
}

export async function flushTelemetryOutbox() {
  const state = await resolveTelemetryState();
  if (!state.enabled || state.mode !== "normal") return;

  const files = (await listOutboxFiles()).slice(0, MAX_FILES_PER_FLUSH);
  for (const filePath of files) {
    let contents: string;
    try {
      contents = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    try {
      const response = await fetch(state.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `vana-cli/unknown`,
        },
        body: contents,
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });
      if (response.status === 202) {
        await fs.rm(filePath, { force: true });
      }
    } catch {
      // Keep file in outbox for retry.
    }
  }
}

// ── Public helpers ──────────────────────────────────────────────────────────

export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  const state = await resolveTelemetryState();
  return {
    enabled: state.enabled,
    mode: state.mode === "local_only" ? "disabled" : state.mode,
    reason: state.reason,
    installId: state.installId,
    endpoint: state.endpoint,
    queuedBatches: state.queuedBatches,
  };
}

export async function setTelemetryEnabled(enabled: boolean) {
  await updateCliConfig({ telemetryEnabled: enabled });
}

export function setActiveTelemetrySession(session: CliTelemetrySession | null) {
  activeSession = session;
}

export function getActiveTelemetrySession() {
  return activeSession;
}

// ── Session ─────────────────────────────────────────────────────────────────

export async function createCliTelemetrySession(
  context: TelemetryCommandContext,
): Promise<CliTelemetrySession> {
  const state = await resolveTelemetryState(Boolean(context.localOnly));
  const factory = createEventFactory(context, state);
  const startedAt = Date.now();
  const events: TelemetryEvent[] = [];

  // Per-session state. A single CLI invocation is ONE host run, with zero
  // or more collection runs and sync attempts nested within.
  const hostRunId = factory.hostRunId;
  let collectionRunId: string | null = null;
  let collectionSource: string | null = context.source ?? null;
  let connectorVersion: string | undefined;
  let authMode: string | undefined;
  let syncRunId: string | null = null;
  let latestOutcomeRaw: string | null = null;
  let latestOutcomeReason: string | null = null;
  let collectionTerminated = false;
  // A connector wrote a result the CLI has not yet accepted as data.
  let resultPending = false;
  let persisted = false;

  const automation = detectAutomation(context.options);
  // `--no-input` without `--ipc` leaves nobody to answer a prompt, so the
  // first request for input is where the run ends.
  const inputImpossible = context.options.noInput && !context.options.ipc;

  // Host-level extensions captured from the command context. These are
  // producer-specific details that don't belong in the canonical Kind.
  const hostExtensions: Record<string, unknown> = {
    command: context.command,
    subcommand: context.subcommand ?? null,
    channel: context.channel,
    installMethod: context.installMethod,
    isCi: automation === "ci",
    isAgent: automation === "agent",
    automation,
    isInteractive: Boolean(
      process.stdin.isTTY && process.stdout.isTTY && !context.options.noInput,
    ),
  };

  const push = (event: TelemetryEvent) => {
    if (!state.enabled && state.mode !== "debug") return;
    events.push(event);
  };

  // Emit host/started immediately.
  push(
    factory.build({
      correlation: { scope: "host", hostRunId },
      kind: { lifecycle: "host", phase: "started" },
      extensions: hostExtensions,
    }),
  );

  // Helper to lazily start a collection run the first time we see collection activity.
  const ensureCollectionStarted = () => {
    if (collectionRunId) return;
    if (!collectionSource) return;
    collectionRunId = randomId("col");
    push(
      factory.build({
        correlation: {
          scope: "collection",
          hostRunId,
          collectionRunId,
          source: collectionSource,
        },
        kind: { lifecycle: "collection", phase: "started" },
        connectorVersion,
        authMode,
        extensions: { automation },
      }),
    );
  };

  // `vana collect` runs several sources in one invocation. Each one is its
  // own collection run, so a new source starts from a clean slate.
  const beginSourceRun = (source: string) => {
    collectionSource = source;
    collectionRunId = null;
    collectionTerminated = false;
    resultPending = false;
    connectorVersion = undefined;
    latestOutcomeRaw = null;
    latestOutcomeReason = null;
  };

  const emitCollectionEvent = (
    kind: TelemetryKind & { lifecycle: "collection" },
  ) => {
    // Exactly one terminal per run, and nothing after it.
    if (collectionTerminated) return;

    ensureCollectionStarted();
    if (!collectionRunId || !collectionSource) return;

    const isTerminal = kind.phase === "terminal";
    if (isTerminal) collectionTerminated = true;

    push(
      factory.build({
        correlation: {
          scope: "collection",
          hostRunId,
          collectionRunId,
          source: collectionSource,
        },
        kind,
        connectorVersion,
        ...(isTerminal ? { extensions: { automation } } : {}),
      }),
    );
  };

  const emitCollectionCancelled = (reason: TelemetryCancellationReason) => {
    emitCollectionEvent({
      lifecycle: "collection",
      phase: "terminal",
      outcome: "cancelled",
      reason,
    });
  };

  const emitCollectionSuccess = () => {
    emitCollectionEvent({
      lifecycle: "collection",
      phase: "terminal",
      outcome: "success",
    });
  };

  // A result file is not yet a success: the CLI rejects one that only holds
  // an error. Settle it once the CLI says which it was.
  const settleResult = (accepted: boolean, detail?: string | null) => {
    if (!resultPending) return;
    resultPending = false;

    if (accepted) {
      emitCollectionSuccess();
      return;
    }
    emitCollectionEvent({
      lifecycle: "collection",
      phase: "terminal",
      outcome: "failure",
      errorClass: classifyRuntimeFailure(detail),
    });
  };

  // Close a run the connector never terminated, from how the CLI ended it.
  // `exitCode` is null when the command is still going (next source).
  const closeCollection = (raw: string | null, exitCode: number | null) => {
    if (!collectionRunId || collectionTerminated) return;

    if (exitCode === 0) {
      emitCollectionSuccess();
      return;
    }

    const cancellation = cancellationFor(raw, latestOutcomeReason);
    if (cancellation) {
      emitCollectionCancelled(cancellation);
      return;
    }

    emitCollectionEvent({
      lifecycle: "collection",
      phase: "terminal",
      outcome: "failure",
      errorClass: classifyCanonicalError(raw),
    });
  };

  const ensureSyncRunId = () => {
    if (!syncRunId) syncRunId = randomId("sync");
    return syncRunId;
  };

  const emitSyncEvent = (kind: TelemetryKind & { lifecycle: "sync" }) => {
    if (!collectionSource) return;
    push(
      factory.build({
        correlation: {
          scope: "sync",
          hostRunId,
          syncRunId: ensureSyncRunId(),
          source: collectionSource,
          ...(collectionRunId ? { collectionRunId } : {}),
        },
        kind,
      }),
    );
  };

  const countScopeResults = (
    scopeResults?: Array<{ status: "stored" | "failed"; scope: string }>,
  ) => {
    const stored =
      scopeResults?.filter((s) => s.status === "stored").length ?? 0;
    const failed =
      scopeResults?.filter((s) => s.status === "failed").length ?? 0;
    return { stored, failed };
  };

  return {
    trackCliEvent(event) {
      // Capture connector version / source / auth mode from any event that carries them.
      if (
        "source" in event &&
        event.source &&
        event.source !== collectionSource
      ) {
        closeCollection(latestOutcomeRaw, null);
        beginSourceRun(event.source);
      }

      switch (event.type) {
        case "setup-check":
          // Setup-phase events are producer-specific and don't fit the shared
          // lifecycle. Attach them to the host extensions instead.
          hostExtensions.runtimeCheckCompleted = true;
          break;
        case "setup-complete":
          hostExtensions.runtimeInstallCompleted = true;
          break;
        case "connector-resolved":
          hostExtensions.connectorResolved = true;
          connectorVersion = event.connectorVersion;
          break;

        case "needs-input":
          emitCollectionEvent({
            lifecycle: "collection",
            phase: "needs_input",
            ...(mapInteractionKind(event.fields?.join(",") ?? null)
              ? {
                  interactionKind: mapInteractionKind(
                    event.fields?.join(",") ?? null,
                  )!,
                }
              : {}),
          });
          if (inputImpossible) emitCollectionCancelled("abandoned");
          break;

        case "legacy-auth":
          // Legacy auth is effectively a "needs manual action" interaction.
          emitCollectionEvent({
            lifecycle: "collection",
            phase: "needs_input",
            interactionKind: "manual_action",
          });
          if (inputImpossible) emitCollectionCancelled("abandoned");
          break;

        case "collection-complete":
          ensureCollectionStarted();
          resultPending = !collectionTerminated;
          break;

        case "runtime-error":
          emitCollectionEvent({
            lifecycle: "collection",
            phase: "terminal",
            outcome: "failure",
            errorClass: classifyRuntimeFailure(event.message),
          });
          break;

        case "ingest-started":
          settleResult(true);
          emitSyncEvent({ lifecycle: "sync", phase: "started" });
          break;
        case "ingest-complete": {
          const { stored, failed } = countScopeResults(event.scopeResults);
          emitSyncEvent({
            lifecycle: "sync",
            phase: "terminal",
            outcome: "success",
            storedScopeCount: stored,
            failedScopeCount: failed,
          });
          syncRunId = null;
          break;
        }
        case "ingest-partial": {
          // Partial in the CLI means "some scopes stored, some failed" — in
          // the canonical contract that is `outcome: success` with
          // failedScopeCount > 0. The UI derives the "partial" label.
          const { stored, failed } = countScopeResults(event.scopeResults);
          emitSyncEvent({
            lifecycle: "sync",
            phase: "terminal",
            outcome: "success",
            storedScopeCount: stored,
            failedScopeCount: failed,
          });
          syncRunId = null;
          break;
        }
        case "ingest-failed":
          emitSyncEvent({
            lifecycle: "sync",
            phase: "terminal",
            outcome: "failure",
            errorClass: classifyCanonicalError("ingest_failed"),
          });
          syncRunId = null;
          break;
        case "ingest-skipped":
          settleResult(true);
          // Skip is standalone — no preceding `started` event.
          syncRunId = randomId("sync"); // fresh ID for the standalone skip
          emitSyncEvent({
            lifecycle: "sync",
            phase: "skipped",
            reason:
              classifyCanonicalError(event.reason) ===
              "personal_server_unavailable"
                ? "server_unavailable"
                : "not_requested",
          });
          syncRunId = null;
          break;

        case "outcome":
          latestOutcomeRaw = event.status ?? null;
          latestOutcomeReason =
            typeof event.reason === "string" ? event.reason : null;
          settleResult(
            COLLECTED_OUTCOMES.has(latestOutcomeRaw ?? ""),
            latestOutcomeReason,
          );
          break;

        case "progress-update":
        case "status-update":
        case "headed-required":
        case "jpeg":
          // Not modeled in canonical telemetry.
          break;
      }
    },

    markCommandResult(result) {
      const durationMs = Date.now() - startedAt;
      latestOutcomeRaw = result.outcome ?? latestOutcomeRaw;

      // If a collection run was started but never terminated, close it here.
      closeCollection(result.errorClass ?? latestOutcomeRaw, result.exitCode);

      // Host terminal.
      if (result.exitCode === 0) {
        push(
          factory.build({
            correlation: { scope: "host", hostRunId },
            kind: { lifecycle: "host", phase: "terminal", outcome: "success" },
            durationMs,
          }),
        );
      } else {
        push(
          factory.build({
            correlation: { scope: "host", hostRunId },
            kind: {
              lifecycle: "host",
              phase: "terminal",
              outcome: "failure",
              errorClass: classifyCanonicalError(
                result.errorClass ?? latestOutcomeRaw,
              ),
            },
            durationMs,
          }),
        );
      }
    },

    async persist() {
      if (persisted) return;
      persisted = true;
      if (state.mode === "debug") {
        for (const envelope of splitIntoEnvelopes(events)) {
          process.stderr.write(`${JSON.stringify(envelope)}\n`);
        }
        return;
      }
      if (!state.enabled) return;

      const envelopes = splitIntoEnvelopes(events);
      for (const envelope of envelopes) {
        await writeEnvelope(envelope, hostRunId);
      }
    },

    trackCustomEvent() {
      // No-op. See the CliTelemetrySession interface doc.
    },

    async flush() {
      await flushTelemetryOutbox();
    },
  };
}

// ── Deprecated ──────────────────────────────────────────────────────────────

/** @deprecated trackCustomEvent on the session is a no-op in the canonical
 *  model. This top-level helper is also a no-op — kept only to satisfy
 *  existing call sites. */
export function trackActiveTelemetryEvent(
  _eventName?: string,
  _patch?: unknown,
) {
  /* intentionally blank */
}
