/**
 * Pure data-gathering query functions for CLI commands.
 *
 * Each function returns the structured data that the corresponding `run*`
 * handler needs for both `--json` serialization and human rendering.
 * No stdout/stderr writes happen here.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";

import {
  getCliStatePath,
  getSourceResultPath,
  getBrowserProfilesDir,
  getConnectorCacheDir,
  getVanaHome,
  getLogsDir,
  readCliState,
} from "../core/index.js";
import type {
  CliDoctor,
  CliDoctorCheck,
  CliStatus,
  SourceStatus,
} from "../core/cli-types.js";
import type { AvailableSource } from "../connectors/registry.js";
import {
  formatUnknownSourceMessage,
  lookupSource,
} from "../connectors/lookup.js";
import { detectPersonalServerTarget } from "../personal-server/index.js";
import { ManagedPlaywrightRuntime } from "../runtime/index.js";
import { formatDisplayPath } from "./render/index.js";

// ── Re-used internal helpers ──────────────────────────────────────────
// Exported from index.ts for reuse by query functions. These are internal
// helpers (not part of the public SDK API) shared between the CLI command
// handlers and the query layer.

import {
  loadRegistrySources,
  createSourceLabelMap,
  createSourceMetadataMap,
  gatherSourceStatuses,
  listInstalledConnectorFiles,
  hasCollectedData,
  isSourceAttention,
  isRetiredSource,
  compareSourceStatusOrder,
  readResultSummary,
  summarizeResultData,
  getCliVersion,
  getCliChannel,
  getCliInstallMethod,
  getLifecycleCommands,
  getDoctorAppRootPath,
  buildStatusNextSteps,
  buildSourcesNextSteps,
  buildDataListNextSteps,
  buildDataShowNextSteps,
  compareDatasetOrder,
  displaySource,
  getSourceStatusPresentation,
  humanizeIssue,
} from "./index.js";

// ── Return types ──────────────────────────────────────────────────────

/** Result of `queryStatus()`. Contains everything both JSON and human paths need. */
export interface StatusQueryResult {
  status: CliStatus;
  nextSteps: string[];
}

/** Result of `querySources()`. Matches the `--json` output shape exactly. */
export interface SourcesQueryResult {
  count: number;
  recommendedSource:
    | (AvailableSource & {
        installed: boolean;
        dataState?: SourceStatus["dataState"];
        lastRunOutcome?: string | null;
        sessionPresent?: boolean;
      })
    | null;
  nextSteps: string[];
  summary: {
    connectedCount: number;
    readyCount: number;
    manualCount: number;
    installedCount: number;
  };
  sources: Array<
    AvailableSource & {
      installed: boolean;
      dataState?: SourceStatus["dataState"];
      lastRunOutcome?: string | null;
      sessionPresent?: boolean;
    }
  >;
}

/** A single dataset record as returned by data-list and data-show queries. */
export interface DatasetRecord {
  source: string;
  name: string | null;
  authMode: "automated" | "interactive" | "legacy" | null;
  dataState?: SourceStatus["dataState"];
  lastRunAt: string | null;
  path: string | null;
  summary: { lines: string[] } | null;
}

/** Result of `queryDataList()`. Matches the `--json` output shape exactly. */
export interface DataListQueryResult {
  count: number;
  latestDataset: DatasetRecord | null;
  nextSteps: string[];
  summary: {
    localCount: number;
    syncedCount: number;
    syncFailedCount: number;
  };
  datasets: DatasetRecord[];
}

/** Successful result of `queryDataShow()`. */
export interface DataShowSuccess {
  ok: true;
  source: string;
  name: string;
  path: string;
  summary: { lines: string[] } | null;
  lastRunAt: string | null;
  dataState: SourceStatus["dataState"] | null;
  nextSteps: string[];
  data: Record<string, unknown>;
  datasetCount: number;
}

/** Not-found result of `queryDataShow()`. */
export interface DataShowNotFound {
  ok: false;
  error: "dataset_not_found";
  source: string;
  message: string;
  nextSteps: string[];
  datasetCount: number;
  /** A result file the last run left without data, when there is one. */
  resultPath?: string;
  /** The last run's log, when the run that should have collected failed. */
  logPath?: string;
}

/** `queryDataShow()` for an id no connector has. */
export interface DataShowUnknownSource {
  ok: false;
  error: "unknown_source";
  source: string;
  message: string;
  nextSteps: string[];
  suggestedSource: string | null;
}

/** Read-failure result of `queryDataShow()`. */
export interface DataShowReadFailed {
  ok: false;
  error: "dataset_read_failed";
  source: string;
  path: string;
  message: string;
}

export type DataShowQueryResult =
  | DataShowSuccess
  | DataShowNotFound
  | DataShowUnknownSource
  | DataShowReadFailed;

/** Result of `queryDoctor()`. Matches the `CliDoctor` type exactly. */
export type DoctorQueryResult = CliDoctor;

// ── Query functions ───────────────────────────────────────────────────

/**
 * Gather status data for `vana status`.
 *
 * Returns the full `CliStatus` plus computed `nextSteps`.
 * The `--json` handler selects the compact subset it needs.
 */
export async function queryStatus(): Promise<StatusQueryResult> {
  const runtime = new ManagedPlaywrightRuntime();
  const personalServer = await detectPersonalServerTarget();
  const state = await readCliState();
  const registrySources = await loadRegistrySources();
  const sourceLabels = createSourceLabelMap(registrySources);
  const sourceMetadata = createSourceMetadataMap(registrySources);
  const sources = (
    await gatherSourceStatuses(state.sources, sourceMetadata)
  ).filter((source) => !isRetiredSource(source, registrySources));

  const pendingSyncCount = sources.filter(
    (source) =>
      source.dataState === "collected_local" ||
      source.dataState === "ingest_unavailable",
  ).length;

  // Count stored scopes across all sources
  let totalStoredScopes = 0;
  for (const stored of Object.values(state.sources)) {
    if (stored?.ingestScopes) {
      totalStoredScopes += stored.ingestScopes.filter(
        (s) => s.status === "stored",
      ).length;
    }
  }

  const status: CliStatus = {
    cliVersion: getCliVersion(),
    channel: getCliChannel(),
    installMethod: getCliInstallMethod(),
    runtime: runtime.state,
    runtimePath: runtime.runtimePath,
    personalServer: personalServer.state,
    personalServerUrl: personalServer.url,
    personalServerSource: personalServer.source,
    personalServerOwner: personalServer.health?.owner ?? null,
    personalServerInfo: {
      url: personalServer.url,
      status: personalServer.state,
      scopeCount: totalStoredScopes,
    },
    pendingSyncCount,
    summary: {
      sourceCount: sources.length,
      needsAttentionCount: sources.filter(isSourceAttention).length,
      connectedCount: sources.filter(
        (source) =>
          source.dataState === "ingested_personal_server" ||
          source.dataState === "ingest_unavailable" ||
          source.dataState === "collected_local" ||
          source.dataState === "ingest_failed",
      ).length,
      installedCount: sources.filter((source) => source.installed).length,
      localCount: sources.filter(
        (source) =>
          source.dataState === "collected_local" ||
          source.dataState === "ingest_unavailable",
      ).length,
      syncedCount: sources.filter(
        (source) => source.dataState === "ingested_personal_server",
      ).length,
      syncFailedCount: sources.filter(
        (source) => source.dataState === "ingest_failed",
      ).length,
    },
    sources,
  };

  const nextSteps = buildStatusNextSteps(
    status.sources,
    sourceLabels,
    status.runtime,
    registrySources,
  );

  // Check for version updates.
  for (const source of status.sources) {
    const registrySource = registrySources.find((s) => s.id === source.source);
    if (
      registrySource?.version &&
      source.connectorVersion &&
      registrySource.version !== source.connectorVersion
    ) {
      nextSteps.push(
        `Update ${displaySource(source.source, sourceLabels)} connector (${source.connectorVersion} -> ${registrySource.version}) with \`vana connect ${source.source}\`.`,
      );
    }
  }

  const overdueCount = sources.filter((s) => s.isOverdue).length;
  if (overdueCount > 0) {
    nextSteps.push(
      `${overdueCount} source(s) overdue for collection. Run \`vana collect --all\`.`,
    );
  }

  if (pendingSyncCount > 0) {
    nextSteps.push(
      `Sync ${pendingSyncCount} pending dataset(s) with \`vana server sync\`.`,
    );
  }

  return { status, nextSteps };
}

/**
 * Gather sources data for `vana sources`.
 *
 * Returns the enriched source list with counts and recommendations.
 */
export async function querySources(): Promise<SourcesQueryResult> {
  const sources = await loadRegistrySources();
  const state = await readCliState();
  const sourceMetadata = createSourceMetadataMap(sources);
  const statuses = await gatherSourceStatuses(state.sources, sourceMetadata);
  const statusMap = new Map(statuses.map((source) => [source.source, source]));
  const installedSourceIds = new Set(
    (await listInstalledConnectorFiles()).map((source) => source.source),
  );
  const enrichedSources = sources.map((source) => {
    const status = statusMap.get(source.id);
    return {
      ...source,
      installed: installedSourceIds.has(source.id),
      dataState: status?.dataState,
      lastRunOutcome: status?.lastRunOutcome ?? null,
      sessionPresent: status?.sessionPresent ?? false,
    };
  });
  const readyCount = enrichedSources.filter(
    (source) =>
      source.authMode !== "legacy" && !hasCollectedData(source.dataState),
  ).length;
  const manualCount = enrichedSources.filter(
    (source) =>
      source.authMode === "legacy" && !hasCollectedData(source.dataState),
  ).length;
  const connectedCount = enrichedSources.filter(
    (source) =>
      source.dataState === "ingest_unavailable" ||
      source.dataState === "collected_local" ||
      source.dataState === "ingested_personal_server" ||
      source.dataState === "ingest_failed",
  ).length;
  const recommendedSource =
    enrichedSources.find(
      (source) =>
        source.authMode !== "legacy" &&
        source.dataState !== "ingest_unavailable" &&
        source.dataState !== "collected_local" &&
        source.dataState !== "ingested_personal_server" &&
        source.dataState !== "ingest_failed",
    ) ??
    enrichedSources.find(
      (source) =>
        source.dataState !== "ingest_unavailable" &&
        source.dataState !== "collected_local" &&
        source.dataState !== "ingested_personal_server" &&
        source.dataState !== "ingest_failed",
    ) ??
    null;
  const nextSteps = buildSourcesNextSteps(recommendedSource, connectedCount);

  return {
    count: enrichedSources.length,
    recommendedSource,
    nextSteps,
    summary: {
      connectedCount,
      readyCount,
      manualCount,
      installedCount: enrichedSources.filter((source) => source.installed)
        .length,
    },
    sources: enrichedSources,
  };
}

/**
 * Gather dataset list for `vana data list`.
 *
 * Returns all collected datasets with summaries and counts.
 */
export async function queryDataList(): Promise<DataListQueryResult> {
  const state = await readCliState();
  const registrySources = await loadRegistrySources();
  const sources = await gatherSourceStatuses(
    state.sources,
    createSourceMetadataMap(registrySources),
  );
  const datasetRecords: DatasetRecord[] = await Promise.all(
    sources
      .filter((source) => Boolean(source.lastResultPath))
      .map(async (source) => ({
        source: source.source,
        name: source.name ?? null,
        authMode: source.authMode ?? null,
        dataState: source.dataState,
        lastRunAt: source.lastRunAt ?? null,
        path: source.lastResultPath ?? null,
        summary: source.lastResultPath
          ? await readResultSummary(source.lastResultPath)
          : null,
      })),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasetRecords.sort(compareDatasetOrder as any);
  const nextSteps = buildDataListNextSteps(datasetRecords, registrySources);

  return {
    count: datasetRecords.length,
    latestDataset: datasetRecords[0] ?? null,
    nextSteps,
    summary: {
      localCount: datasetRecords.filter(
        (dataset) => dataset.dataState !== "ingested_personal_server",
      ).length,
      syncedCount: datasetRecords.filter(
        (dataset) => dataset.dataState === "ingested_personal_server",
      ).length,
      syncFailedCount: datasetRecords.filter(
        (dataset) => dataset.dataState === "ingest_failed",
      ).length,
    },
    datasets: datasetRecords,
  };
}

/**
 * Gather data for `vana data show <source>`.
 *
 * Returns the dataset contents and metadata, or an error descriptor.
 */
export async function queryDataShow(
  source: string,
): Promise<DataShowQueryResult> {
  const registrySources = await loadRegistrySources();
  const sourceLabels = createSourceLabelMap(registrySources);
  const state = await readCliState();
  const datasetCount = Object.values(state.sources).filter((entry) =>
    Boolean(entry?.lastResultPath),
  ).length;

  // An id from state is taken as is, even when its connector is gone; the
  // rest go through the catalog, which also takes names ("Claude Code").
  // Without a catalog, nothing can be called unknown.
  if (!state.sources[source] && registrySources.length > 0) {
    const { match, suggestion } = lookupSource(source, registrySources);
    if (!match) {
      return {
        ok: false,
        error: "unknown_source",
        source,
        message: formatUnknownSourceMessage(source, suggestion),
        nextSteps: [
          suggestion
            ? `Run \`vana data show ${suggestion.id}\` if you meant ${suggestion.name}.`
            : "Run `vana sources` to see available sources.",
        ],
        suggestedSource: suggestion?.id ?? null,
      };
    }
    source = match.id;
  }

  const record = state.sources[source];
  const resultPath = record?.lastResultPath;

  if (!resultPath) {
    // The id as typed when the catalog has no name for it: "Claude-code"
    // reads as a name nobody uses.
    const name = sourceLabels[source] ?? source;
    // A run that wrote no data (an error or an empty export) leaves a
    // result file but no dataset; say so instead of "nothing found".
    const leftover = getSourceResultPath(source);
    const resultFile = fs.existsSync(leftover) ? leftover : undefined;
    const logPath = record?.lastLogPath ?? undefined;
    const failed =
      Boolean(record?.lastRunOutcome) &&
      record?.lastRunOutcome !== "connected_local_only" &&
      record?.lastRunOutcome !== "connected_and_ingested";
    if (resultFile || failed) {
      const reason = record?.lastError
        ? humanizeIssue(record.lastError).replace(/\.$/, "")
        : null;
      const message = failed
        ? `${name} has no data: the last run failed${reason ? ` (${reason})` : ""}.`
        : `${name}'s last run saved an empty result, with no data in it.`;
      return {
        ok: false,
        error: "dataset_not_found",
        source,
        message,
        nextSteps: [
          ...(logPath
            ? [`See what happened with \`vana logs ${source}\`.`]
            : []),
          `Run \`vana connect ${source}\` to try again.`,
        ],
        datasetCount,
        ...(resultFile ? { resultPath: resultFile } : {}),
        ...(logPath ? { logPath } : {}),
      };
    }
    return {
      ok: false,
      error: "dataset_not_found",
      source,
      message: `No collected dataset found for ${name}. Run \`vana connect ${source}\` first.`,
      nextSteps: [
        `Run \`vana connect ${source}\` to collect data.`,
        ...(datasetCount > 0
          ? ["Run `vana data list` to inspect other datasets."]
          : []),
      ],
      datasetCount,
    };
  }

  try {
    const raw = await fsp.readFile(resultPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const summary = summarizeResultData(data);
    const nextSteps = buildDataShowNextSteps(
      source,
      datasetCount,
      sourceLabels,
    );
    return {
      ok: true,
      source,
      name: displaySource(source, sourceLabels),
      path: resultPath,
      summary,
      lastRunAt: record?.lastRunAt ?? null,
      dataState: (record?.dataState ?? null) as
        | "none"
        | "collected_local"
        | "ingested_personal_server"
        | "ingest_unavailable"
        | "ingest_failed"
        | null,
      nextSteps,
      data,
      datasetCount,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Could not read ${resultPath}.`;
    return {
      ok: false,
      error: "dataset_read_failed",
      source,
      path: resultPath,
      message,
    };
  }
}

/**
 * Gather diagnostic data for `vana doctor`.
 *
 * Returns the full `CliDoctor` payload.
 */
export async function queryDoctor(): Promise<DoctorQueryResult> {
  const runtime = new ManagedPlaywrightRuntime();
  const personalServer = await detectPersonalServerTarget();
  const state = await readCliState();
  const registrySources = await loadRegistrySources();
  const sourceMetadata = createSourceMetadataMap(registrySources);
  const sourceLabels = createSourceLabelMap(registrySources);
  const sources = (
    await gatherSourceStatuses(state.sources, sourceMetadata)
  ).filter((source) => !isRetiredSource(source, registrySources));
  const cliVersion = getCliVersion();
  const cliChannel = getCliChannel(cliVersion);
  const installMethod = getCliInstallMethod();
  const lifecycle = getLifecycleCommands(installMethod, cliChannel);
  const appRootPath = getDoctorAppRootPath(installMethod);
  const recentSources = [...sources]
    .filter((source) => Boolean(source.lastRunAt))
    .sort(compareSourceStatusOrder)
    .slice(0, 3);
  const attentionSources = recentSources.filter((source) =>
    isSourceAttention(source),
  );
  const connectedCount = sources.filter(
    (source) =>
      source.dataState === "ingest_unavailable" ||
      source.dataState === "collected_local" ||
      source.dataState === "ingested_personal_server" ||
      source.dataState === "ingest_failed",
  ).length;
  const attentionCount = sources.filter(isSourceAttention).length;

  const directories = [
    {
      key: "executable",
      label: "Executable",
      path: process.execPath,
      present: fs.existsSync(process.execPath),
    },
    ...(appRootPath
      ? [
          {
            key: "appRoot",
            label: "App root",
            path: appRootPath,
            present: fs.existsSync(appRootPath),
          },
        ]
      : []),
    {
      key: "dataHome",
      label: "Data home",
      path: getVanaHome(),
      present: fs.existsSync(getVanaHome()),
    },
    {
      key: "stateFile",
      label: "State file",
      path: getCliStatePath(),
      present: fs.existsSync(getCliStatePath()),
    },
    {
      key: "connectorCache",
      label: "Connector cache",
      path: getConnectorCacheDir(),
      present: fs.existsSync(getConnectorCacheDir()),
    },
    {
      key: "browserProfiles",
      label: "Browser profiles",
      path: getBrowserProfilesDir(),
      present: fs.existsSync(getBrowserProfilesDir()),
    },
    {
      key: "logs",
      label: "Logs",
      path: getLogsDir(),
      present: fs.existsSync(getLogsDir()),
    },
  ];

  const checks: CliDoctorCheck[] = [
    {
      key: "cli",
      label: "CLI",
      status: "ok",
      detail: `Version ${cliVersion}`,
    },
    {
      key: "runtime",
      label: "Runtime",
      status: runtime.state === "installed" ? "ok" : "warn",
      detail:
        runtime.state === "installed"
          ? `Browser available at ${formatDisplayPath(runtime.runtimePath ?? "unknown")}`
          : "Run `vana setup` to install the local browser runtime.",
    },
    {
      key: "personalServer",
      label: "Personal Server",
      status: personalServer.state === "available" ? "ok" : "warn",
      detail:
        personalServer.state === "available"
          ? (personalServer.url ?? "Available")
          : "Unavailable. Connects will stay local until a Personal Server is reachable.",
    },
    ...directories.map<CliDoctorCheck>((entry) => ({
      key: entry.key,
      label: entry.label,
      status: entry.present ? "ok" : "warn",
      detail: `${entry.present ? "Present" : "Missing"} at ${formatDisplayPath(entry.path)}`,
    })),
    {
      key: "sources",
      label: "Tracked sources",
      status: "ok" as const,
      detail: `${Object.keys(state.sources).length} source${Object.keys(state.sources).length === 1 ? "" : "s"} in local state`,
    },
    ...(attentionSources[0]
      ? [
          {
            key: "latestIssue",
            label: "Latest issue",
            status: "warn" as const,
            detail: `${displaySource(attentionSources[0].source, sourceLabels)}: ${humanizeIssue(attentionSources[0].lastError ?? getSourceStatusPresentation(attentionSources[0]).label)}`,
          },
        ]
      : []),
  ];

  const nextSteps = [
    ...(runtime.state !== "installed"
      ? ["Install the local runtime with `vana setup`."]
      : []),
    ...(personalServer.state !== "available"
      ? [
          "Your Personal Server is unavailable, so successful runs will stay local.",
        ]
      : []),
    ...(attentionSources[0]?.lastLogPath
      ? [
          `Inspect the latest issue log with \`vana logs ${attentionSources[0].source}\`.`,
        ]
      : attentionSources[0]
        ? [`View details with \`vana logs ${attentionSources[0].source}\`.`]
        : Object.keys(state.sources).length === 0
          ? [
              (() => {
                const suggested = registrySources.find(
                  (s) => s.authMode !== "legacy",
                );
                return suggested
                  ? `Connect your first source with \`vana connect ${suggested.id}\`.`
                  : "Connect your first source with `vana connect`.";
              })(),
            ]
          : [
              (() => {
                const suggested = registrySources.find(
                  (s) => s.authMode !== "legacy",
                );
                return suggested
                  ? `Connect a source with \`vana connect ${suggested.id}\`.`
                  : "Connect a source with `vana connect`.";
              })(),
            ]),
  ];

  return {
    cliVersion,
    channel: cliChannel,
    installMethod,
    runtime: runtime.state,
    runtimePath: runtime.runtimePath,
    personalServer: personalServer.state,
    personalServerUrl: personalServer.url,
    personalServerSource: personalServer.source,
    capabilities: runtime.capabilities,
    paths: {
      executable: process.execPath,
      appRoot: appRootPath,
      dataHome: getVanaHome(),
      stateFile: getCliStatePath(),
      connectorCache: getConnectorCacheDir(),
      browserProfiles: getBrowserProfilesDir(),
      logs: getLogsDir(),
    },
    lifecycle,
    summary: {
      trackedSourceCount: Object.keys(state.sources).length,
      attentionCount,
      connectedCount,
    },
    recentSources,
    checks,
    nextSteps,
  };
}
