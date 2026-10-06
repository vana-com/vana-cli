import os from "node:os";
import path from "node:path";

import { CliExitCode } from "../core/exit-codes.js";
import type {
  ScheduledRunRecord,
  ScheduledSourceOutcome,
  StoredSourceState,
} from "../core/state-store.js";

/**
 * What a scheduled collection runs against, and how to tell when an
 * installed job has drifted from it.
 *
 * A scheduler starts the job with none of the creating shell's environment.
 * A plist written from a shell with `VANA_HOME` set once took its log path
 * from that home while the job itself ran against the default ~/.vana, so it
 * collected into one state and logged into another (a /tmp test home the OS
 * wiped), and every failing night went unseen. The job therefore carries the
 * selection env it was created with, and its log always sits inside the home
 * it runs against.
 */

/** The job id launchd knows the scheduled collection by. */
export const LAUNCHD_LABEL = "com.vana.collect";

/** Marks the cron line as ours, so add and remove find it again. */
export const CRONTAB_MARKER = "# vana-scheduled-collection";

/** Set on the scheduled job so `collect --all` records its outcome. */
export const SCHEDULED_RUN_ENV = "VANA_SCHEDULED_RUN";

/**
 * Env that decides which state, network and server a run uses, copied from
 * the creating shell into the job. Secrets (VANA_PS_TOKEN,
 * VANA_SESSION_TOKEN, VANA_PRIVATE_KEY) are deliberately absent: a plist and
 * a crontab are readable files, and the job reads its credentials from the
 * state it is pinned to.
 */
export const SCHEDULE_PINNED_ENV_KEYS = [
  "VANA_NETWORK",
  "VANA_ENV",
  "VANA_ACCOUNT_URL",
  "VANA_ACCOUNT_CLIENT_ID",
  "VANA_OAUTH_CLIENT_ID",
  "VANA_PERSONAL_SERVER_URL",
  "VANA_PS_URL",
] as const;

/** The state a scheduled job runs against, and where it logs. */
export interface ScheduleTarget {
  /** Absolute CLI home the job reads and writes. */
  home: string;
  /** Absolute log path, always inside `home`. */
  logPath: string;
  /** Env the job is started with; always includes VANA_HOME. */
  env: Record<string, string>;
}

/** The CLI home an env selects, as `getVanaHome` would resolve it. */
export function vanaHomeForEnv(
  env: Record<string, string | undefined>,
  homeDir = os.homedir(),
): string {
  return env.VANA_HOME
    ? path.resolve(env.VANA_HOME)
    : path.join(homeDir, ".vana");
}

/** The log a scheduled job writes for a given CLI home. */
export function scheduleLogPathFor(home: string): string {
  return path.join(home, "logs", "schedule.log");
}

/**
 * The target for a job created from `env`.
 *
 * @param network - an explicit `--network`, which wins over VANA_NETWORK.
 */
export function resolveScheduleTarget(
  env: Record<string, string | undefined>,
  network?: string,
  homeDir = os.homedir(),
): ScheduleTarget {
  const home = vanaHomeForEnv(env, homeDir);
  const pinned: Record<string, string> = { VANA_HOME: home };
  for (const key of SCHEDULE_PINNED_ENV_KEYS) {
    const value = env[key];
    if (value) pinned[key] = value;
  }
  if (network) pinned.VANA_NETWORK = network;
  pinned[SCHEDULED_RUN_ENV] = "1";
  return { home, logPath: scheduleLogPathFor(home), env: pinned };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The arguments every scheduled job passes after the program. */
export const SCHEDULED_COLLECT_ARGS = [
  "collect",
  "--all",
  "--quiet",
  "--no-input",
] as const;

export function generateLaunchdPlist(
  vanaCommand: string[],
  intervalSeconds: number,
  target: ScheduleTarget,
): string {
  const programArgs = [...vanaCommand, ...SCHEDULED_COLLECT_ARGS]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(target.env)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(target.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(target.logPath)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/** What an installed job actually does, read back from its definition. */
export interface InstalledSchedule {
  intervalSeconds: number | null;
  logPath: string | null;
  /** Env the job is started with; empty for jobs written before pinning. */
  env: Record<string, string>;
}

/** Read the parts of a launchd plist that decide where the job runs. */
export function parseLaunchdPlist(content: string): InstalledSchedule {
  const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(
    content,
  );
  const logPath =
    /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(content);
  const env: Record<string, string> = {};
  const envBlock =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content);
  if (envBlock) {
    const pair = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
    for (const match of envBlock[1].matchAll(pair)) {
      env[unescapeXml(match[1])] = unescapeXml(match[2]);
    }
  }
  return {
    intervalSeconds: interval ? parseInt(interval[1], 10) : null,
    logPath: logPath ? unescapeXml(logPath[1]) : null,
    env,
  };
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unquoteShell(value: string): string {
  return value.replace(/'\\''/g, "'");
}

/**
 * A crontab line for the job. cron, like launchd, starts the command with
 * almost no env, so the pinned env goes in front of the command itself.
 */
export function generateCrontabEntry(
  vanaCommand: string[],
  intervalHours: number,
  target: ScheduleTarget,
): string {
  const hourInterval =
    intervalHours >= 24 ? "0" : intervalHours >= 1 ? `*/${intervalHours}` : "*";
  const envPrefix = Object.entries(target.env)
    .map(([key, value]) => `${key}=${quoteForShell(value)}`)
    .join(" ");
  const program = vanaCommand.map((arg) => quoteForShell(arg)).join(" ");
  return `0 ${hourInterval} * * * ${envPrefix} ${program} ${SCHEDULED_COLLECT_ARGS.join(" ")} >> ${quoteForShell(target.logPath)} 2>&1 ${CRONTAB_MARKER}`;
}

/** Read a crontab line back the way {@link parseLaunchdPlist} reads a plist. */
export function parseCrontabEntry(line: string): InstalledSchedule {
  const env: Record<string, string> = {};
  // Skip the five schedule fields; assignments come before the program.
  let rest = line.replace(/^\s*(?:\S+\s+){5}/, "");
  const assignment = /^([A-Z_][A-Z0-9_]*)='((?:[^']|'\\'')*)'\s+/;
  for (
    let match = assignment.exec(rest);
    match;
    match = assignment.exec(rest)
  ) {
    env[match[1]] = unquoteShell(match[2]);
    rest = rest.slice(match[0].length);
  }
  const log = />>\s*'((?:[^']|'\\'')*)'/.exec(line);
  const hourMatch = /^\S+\s+\*\/(\d+)\s/.exec(line);
  return {
    intervalSeconds: hourMatch ? parseInt(hourMatch[1], 10) * 3600 : 86400,
    logPath: log ? unquoteShell(log[1]) : null,
    env,
  };
}

/** One way an installed job no longer matches what `schedule add` writes. */
export type ScheduleDrift =
  | { kind: "log_outside_home"; logPath: string | null; home: string }
  | { kind: "home_not_pinned"; home: string }
  | { kind: "other_home"; home: string; currentHome: string };

/**
 * Compare an installed job with the state of the shell asking about it.
 *
 * `log_outside_home` and `home_not_pinned` mean the job itself is outdated
 * and `vana schedule add` repairs it. `other_home` only says the job serves
 * a different state than this shell; running add here would move it.
 */
export function diagnoseSchedule(
  installed: InstalledSchedule,
  currentHome: string,
  homeDir = os.homedir(),
): { jobHome: string; drift: ScheduleDrift[] } {
  // Without a pinned VANA_HOME the job runs with the scheduler's HOME, which
  // is the user's own home directory.
  const jobHome = vanaHomeForEnv(installed.env, homeDir);
  const drift: ScheduleDrift[] = [];
  if (installed.logPath !== scheduleLogPathFor(jobHome)) {
    drift.push({
      kind: "log_outside_home",
      logPath: installed.logPath,
      home: jobHome,
    });
  }
  if (!installed.env.VANA_HOME || !installed.env[SCHEDULED_RUN_ENV]) {
    drift.push({ kind: "home_not_pinned", home: jobHome });
  }
  if (jobHome !== currentHome) {
    drift.push({ kind: "other_home", home: jobHome, currentHome });
  }
  return { jobHome, drift };
}

/**
 * The `vana status` line for the last scheduled run: one short clause when
 * it went fine, the failure count and the log when it did not.
 */
export function describeScheduledRun(
  record: ScheduledRunRecord,
  formatTime: (iso: string) => string,
  formatPath: (filePath: string) => string = (p) => p,
): { text: string; failed: boolean } {
  const when = formatTime(record.finishedAt);
  const total = record.sources.length;
  const collectFailed = record.sources.filter(
    (s) => s.outcome === "collect_failed",
  ).length;
  const notSynced = record.sources.filter(
    (s) => s.outcome === "sync_failed" || s.outcome === "sync_pending",
  ).length;

  if (collectFailed === 0 && notSynced === 0) {
    if (record.exitCode !== 0) {
      return {
        text: `${when}, failed (see ${formatPath(record.logPath)})`,
        failed: true,
      };
    }
    return {
      text: total === 0 ? `${when}, nothing was due` : `${when}, ok`,
      failed: false,
    };
  }

  const parts: string[] = [];
  if (collectFailed > 0) {
    parts.push(`${collectFailed} of ${total} failed to collect`);
  }
  if (notSynced > 0) {
    parts.push(`${notSynced} of ${total} failed to sync`);
  }
  return {
    text: `${when}, ${parts.join(", ")} (see ${formatPath(record.logPath)})`,
    failed: true,
  };
}

/** One source's result in a `collect --all` run. */
export interface CollectAllSourceResult {
  source: string;
  outcome: ScheduledSourceOutcome;
  error?: string;
}

/**
 * How a source collected by `collect --all` ended, read from the state its
 * run left behind. A run whose sync failed still exits 0 from `runConnect`
 * (the data is safe locally), which is how a week of 401s went unreported.
 */
export function classifyCollectedSource(
  source: string,
  exitCode: number,
  stored: StoredSourceState | undefined,
): CollectAllSourceResult {
  const error = stored?.lastError ?? undefined;
  if (exitCode !== CliExitCode.OK) {
    return { source, outcome: "collect_failed", error };
  }
  const failedScope = stored?.ingestScopes?.find((s) => s.status === "failed");
  if (
    stored?.dataState === "ingest_failed" ||
    stored?.lastRunOutcome === "ingest_failed" ||
    failedScope
  ) {
    return {
      source,
      outcome: "sync_failed",
      error: error ?? failedScope?.error,
    };
  }
  if (stored?.dataState === "ingest_unavailable") {
    return { source, outcome: "sync_pending" };
  }
  return { source, outcome: "ok" };
}

/**
 * The exit code for a whole `collect --all`: OK only when every source it
 * touched collected and synced. When the only problem is that no Personal
 * Server answered, that is {@link CliExitCode.SERVER_UNAVAILABLE}; anything
 * else is {@link CliExitCode.FAILURE}.
 */
export function collectAllExitCode(
  results: readonly CollectAllSourceResult[],
): CliExitCode {
  const failures = results.filter((r) => r.outcome !== "ok");
  if (failures.length === 0) return CliExitCode.OK;
  return failures.every((r) => r.outcome === "sync_pending")
    ? CliExitCode.SERVER_UNAVAILABLE
    : CliExitCode.FAILURE;
}

/** Lines for stderr when a `collect --all` did not fully succeed. */
export function describeCollectAllFailures(
  results: readonly CollectAllSourceResult[],
): string[] {
  const failures = results.filter((r) => r.outcome !== "ok");
  if (failures.length === 0) return [];
  const label: Record<ScheduledSourceOutcome, string> = {
    ok: "ok",
    collect_failed: "collection failed",
    sync_failed: "sync failed",
    sync_pending: "not synced, no Personal Server answered",
  };
  return [
    `${failures.length} of ${results.length} source(s) did not collect and sync:`,
    ...failures.map(
      (r) =>
        `  ${r.source}: ${label[r.outcome]}${r.error ? ` (${r.error})` : ""}`,
    ),
  ];
}
