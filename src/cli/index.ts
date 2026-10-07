import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import os from "node:os";

import { confirm, input, isPromptInputClosed, password } from "./prompts.js";
import { searchSelect } from "./search-select.js";
import { Command, CommanderError, Option } from "commander";

// Vana-branded theme for inquirer prompts — matches brand palette
const VANA_BLUE = "\x1b[38;2;65;65;252m";
const VANA_GREEN = "\x1b[38;2;0;213;11m";
const VANA_MUTED = "\x1b[38;2;112;112;112m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_RESET = "\x1b[22m";
const vanaPromptTheme = {
  theme: {
    prefix: { idle: `${VANA_BLUE}?${RESET}`, done: `${VANA_GREEN}✓${RESET}` },
    style: {
      answer: (text: string) => `${BOLD}${text}${BOLD_RESET}`,
      message: (text: string, status: "idle" | "done" | "loading") =>
        status === "done" ? `${VANA_MUTED}${text}${RESET}` : text,
      highlight: (text: string) => `${VANA_BLUE}${text}${RESET}`,
      help: (text: string) => `${VANA_MUTED}${text}${RESET}`,
      error: (text: string) => `\x1b[38;2;231;0;11m${text}${RESET}`,
    },
  },
};

import {
  createConnectRenderer,
  createHumanRenderer,
  createLoginRenderer,
  formatDisplayPath,
  formatRelativeTime,
} from "./render/index.js";
import type { ConnectRenderer } from "./render/connect-renderer.js";
import { createProgressHandle } from "./render/progress.js";
import {
  CliOutcomeStatus,
  migrateLegacyDataHome,
  getBrowserProfilesDir,
  getConnectorCacheDir,
  getLogsDir,
  getSessionsDir,
  getSourceResultPath,
  readCliState,
  readCliConfig,
  recordScheduledRun,
  updateCliConfig,
  updateSourceState,
} from "../core/index.js";
import type { StoredSourceState } from "../core/state-store.js";
import {
  CRONTAB_MARKER,
  LAUNCHD_LABEL,
  SCHEDULED_COLLECT_ARGS,
  SCHEDULED_RUN_ENV,
  classifyCollectedSource,
  collectAllExitCode,
  describeCollectAllFailures,
  describeScheduledRun,
  diagnoseSchedule,
  generateCrontabEntry,
  generateLaunchdPlist,
  parseCrontabEntry,
  parseLaunchdPlist,
  resolveScheduleTarget,
  vanaHomeForEnv,
  type CollectAllSourceResult,
  type InstalledSchedule,
  type ScheduleDrift,
} from "./schedule.js";
import { getVanaHome } from "../core/paths.js";
import {
  UnknownNetworkError,
  VANA_NETWORKS,
  isVanaNetworkName,
  resolveNetwork,
  type VanaNetworkName,
} from "../core/network.js";
import { CliExitCode } from "../core/exit-codes.js";
import { registerAppCommands } from "./app/index.js";
import {
  checkRegisteredServers,
  lookupRegisteredServers,
} from "../personal-server/registered.js";
import type {
  CliChannel,
  CliEvent,
  CliInstallMethod,
  CliOutcome,
  CliStatus,
  SourceStatus,
} from "../core/cli-types.js";
import type { AvailableSource } from "../connectors/registry.js";
import {
  formatUnknownSourceMessage,
  lookupSource,
} from "../connectors/lookup.js";
import {
  fetchConnectorToCache,
  listAvailableSources,
  readCachedConnectorMetadata,
} from "../connectors/registry.js";
import {
  detectPersonalServerTarget,
  ingestResult,
  personalServerOwnerMismatch,
  urlsMatch,
  resolvePersonalServerAuthConfig,
} from "../personal-server/index.js";
import type {
  IngestResultOptions,
  PersonalServerTarget,
} from "../personal-server/index.js";
import {
  findDataConnectorsDir,
  ManagedPlaywrightRuntime,
} from "../runtime/index.js";
import { getPdppProfileRoot } from "../pdpp/host.js";
import { runServerStart, type ServerStartIo } from "./server-start.js";
import { findRunningServers } from "../personal-server/local/server.js";
import { stopLocalServer } from "../personal-server/local/detach.js";
import {
  listServerDataDirs,
  runningCliServers,
  serverToStop,
  type CliServerDir,
} from "../personal-server/local/data-dir.js";
import { PdppRuntime } from "../pdpp/runtime.js";
import {
  addLocalConnector,
  LocalConnectorConflictError,
  readLocalConnectors,
  removeLocalConnector,
  resolvePdppSource,
} from "../pdpp/local-connectors.js";
import { readLocalProfile } from "../pdpp/local.js";
import {
  listAvailableSkills,
  installSkill,
  readInstalledSkills,
} from "../skills/index.js";
import {
  queryStatus,
  querySources,
  queryDataList,
  queryDataShow,
  queryDoctor,
} from "./queries.js";
import {
  checkForUpdate,
  readUpdateCheck,
  isNewerVersion,
} from "./update-check.js";
import {
  loadCredentials,
  loadPersonalServerSession,
  readStoredAuthFile,
  readStoredAccountAddress,
  saveCredentials,
  clearCredentials,
  isExpired,
  formatAddress,
  formatExpiresIn,
  getAuthTarget,
  accountSessionToPreserve,
  resolveLoginServerUrl,
  runDeviceCodeFlow,
  runSelfHostedLoginFlow,
  sameAccountAddress,
  stashPersonalServerSession,
  takeStashedPersonalServerSession,
  getAccountUrl,
  type VanaCredentials,
} from "./auth.js";
import {
  createCliTelemetrySession,
  flushTelemetryOutbox,
  getActiveTelemetrySession,
  getTelemetryStatus,
  setActiveTelemetrySession,
  setTelemetryEnabled,
  trackActiveTelemetryEvent,
} from "./telemetry.js";
import { dataScopeKeys, scopeLeaf, scopeList } from "./data-slice.js";

interface GlobalOptions {
  json?: boolean;
  noInput?: boolean;
  ipc?: boolean;
  yes?: boolean;
  quiet?: boolean;
  detach?: boolean;
  /** `--network` value; resolved via resolveNetwork() where needed. */
  network?: VanaNetworkName;
}

/** Long flags shared by every command; declared once, applied to all leaves. */
const GLOBAL_FLAG_DEFS: ReadonlyArray<readonly [string, string]> = [
  ["--json", "Output machine-readable JSON"],
  ["--no-input", "Never prompt; fail or print a URL instead"],
  ["--yes", "Assume yes for confirmation prompts"],
  ["--quiet", "Suppress non-essential output"],
  ["--ipc", "Emit structured IPC events (internal)"],
  ["--detach", "Run in the background where supported"],
] as const;

/**
 * Declare the shared global flags on every leaf command that does not
 * already define them, so commander accepts them anywhere on the line and
 * `--help` documents them. Idempotent per flag.
 */
function applyGlobalOptions(command: Command): void {
  if (command.commands.length === 0) {
    for (const [flags, description] of GLOBAL_FLAG_DEFS) {
      const long = `--${flags.replace(/^--(no-)?/, "")}`;
      const exists = command.options.some(
        (option) => option.long === flags || option.long === long,
      );
      if (!exists) {
        command.option(flags, description);
      }
    }
    if (!command.options.some((option) => option.long === "--network")) {
      command.addOption(
        new Option("--network <network>", "Vana network").choices([
          ...VANA_NETWORKS,
        ]),
      );
    }
    return;
  }
  for (const child of command.commands) {
    applyGlobalOptions(child as Command);
  }
}

/**
 * Merge the options commander actually parsed (root -> action command, child
 * wins) into the pre-parse seed, so action handlers see the authoritative
 * values while pre-parse consumers (update-notifier suppression, telemetry
 * context) keep working from the argv scan.
 */
function mergeParsedGlobalOptions(
  target: GlobalOptions,
  actionCommand: Command,
): void {
  const chain: Command[] = [];
  for (
    let current: Command | null = actionCommand;
    current;
    current = current.parent as Command | null
  ) {
    chain.unshift(current);
  }
  // Only values commander actually parsed count; a leaf's implicit
  // default (e.g. --no-input declaring input: true) must never overwrite a
  // value the user set at another level of the command line.
  const merged: Record<string, unknown> = {};
  for (const command of chain) {
    const opts = command.opts();
    for (const key of Object.keys(opts)) {
      if (command.getOptionValueSource(key) !== "default") {
        merged[key] = opts[key];
      }
    }
  }
  if (merged.json === true) target.json = true;
  if (merged.input === false) target.noInput = true;
  if (merged.yes === true) target.yes = true;
  if (merged.quiet === true) target.quiet = true;
  if (merged.ipc === true) target.ipc = true;
  if (merged.detach === true) target.detach = true;
  if (typeof merged.network === "string" && isVanaNetworkName(merged.network)) {
    target.network = merged.network;
  }
}

interface LoginCommandOptions {
  clientId?: string;
  server?: string;
}

interface SourceLabelMap {
  [source: string]: string;
}

interface SourceMetadataMap {
  [source: string]: {
    name: string;
    company?: string;
    description?: string;
    authMode?: "automated" | "interactive" | "legacy";
    runtime?: "legacy" | "pdpp";
  };
}

function cleanDescription(desc: string): string {
  return desc
    .replace(/ using Playwright browser automation\.?/i, ".")
    .replace(/^Exports\b\s*(your\s+)?/i, "Your ");
}

interface Emitter {
  event(event: CliEvent | CliOutcome): void;
  info(message: string): void;
  blank(): void;
  title(message: string): void;
  success(message: string): void;
  section(message: string): void;
  keyValue(label: string, value: string, tone?: RenderTone): void;
  detail(message: string): void;
  next(command: string): void;
  bullet(message: string): void;
  sourceTitle(
    name: string,
    badges?: Array<{ text: string; tone?: RenderTone }>,
  ): void;
  badge(text: string, tone?: RenderTone): string;
  code(text: string): string;
}

type RenderTone = "accent" | "success" | "warning" | "error" | "muted" | "info";
const require = createRequire(import.meta.url);

type SourceStatusDetail =
  | {
      kind: "text";
      message: string;
    }
  | {
      kind: "row";
      label: string;
      value: string;
      tone?: RenderTone;
    };

export async function runCli(argv = process.argv): Promise<number> {
  // Migrate ~/.dataconnect → ~/.vana, symlink old path for DataConnect compat.
  // Only an actual data migration announces itself; the compat symlink that
  // every fresh install gets on its second run stays silent.
  if (migrateLegacyDataHome() === "migrated") {
    process.stderr.write("Moved your data to ~/.vana.\n\n");
  }

  const normalizedArgv = normalizeArgv(argv);
  if (normalizedArgv.length <= 2) {
    normalizedArgv.push("--help");
  }
  const parsedOptions = extractGlobalOptions(normalizedArgv);
  const cliVersion = getCliVersion();
  const installMethod = getCliInstallMethod();
  const telemetryBaseContext = {
    cliVersion,
    channel: getCliChannel(cliVersion),
    installMethod,
    options: parsedOptions,
  } as const;

  // Non-blocking update check — compute suppression flags early
  const shouldNotify =
    !parsedOptions.json &&
    process.stdout.isTTY &&
    installMethod !== "development" &&
    !process.env.VANA_NO_UPDATE_NOTIFIER &&
    !process.env.CI &&
    !process.env.AGENT &&
    !process.env.VANA_DETACHED;

  // Fire update check concurrently — no await, runs in the background.
  // If it finishes before the command completes, the cache is written and
  // the SAME run can read it for the notification below.
  const updateCheckPromise = shouldNotify
    ? checkForUpdate(cliVersion, installMethod).catch(() => {})
    : undefined;

  const program = new Command();
  program
    .name("vana")
    .description("Connect sources, collect data, and inspect it locally.")
    .version(cliVersion, "-v, --version", "Print CLI version")
    .showSuggestionAfterError(true)
    .addHelpText(
      "after",
      `
Quick start:
  vana login             Log in to your Vana account
  vana connect           Connect a source and collect data
  vana sources           Browse available sources
  vana status            Check system health

Data:
  vana data list         List collected datasets
  vana data show <src>   Inspect a dataset

Server:
  vana server            Personal Server status and management

Connectors:
  vana connectors add <key> --from <dir>   Register a local Collection Profile connector
  vana connectors list                     Show registered local connectors

Agent:
  vana mcp               Start MCP server (for Claude Code, Cursor, etc.)
  vana skills list         List available agent skills
  vana skills install      Install a skill for your agent

Background:
  vana connect <src> --detach   Connect in the background
  vana schedule add             Schedule daily collection
  vana schedule list            Show scheduled tasks

More:
  vana doctor            Detailed diagnostics
  vana logs [source]     View run logs
  vana setup             Install or repair runtime
`,
    );
  program.exitOverride();

  // Global flags: declared here for `vana --help`, mirrored onto every leaf
  // command by applyGlobalOptions() so they are accepted anywhere on the
  // line. Values are merged back into parsedOptions in the preAction hook.
  for (const [flags, description] of GLOBAL_FLAG_DEFS) {
    program.option(flags, description);
  }
  program.addOption(
    new Option(
      "--network <network>",
      "Vana network: mainnet (default) or moksha, the testnet",
    ).choices([...VANA_NETWORKS]),
  );
  program.hook("preAction", (_thisCommand, actionCommand) => {
    mergeParsedGlobalOptions(parsedOptions, actionCommand as Command);
  });

  program
    .command("version")
    .description("Print CLI version")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "version" },
        async () => {
          if (parsedOptions.json) {
            process.stdout.write(
              `${JSON.stringify({
                cliVersion,
                channel: getCliChannel(cliVersion),
                installMethod: getCliInstallMethod(),
              })}\n`,
            );
            return 0;
          }

          process.stdout.write(
            `${cliVersion} (${getCliChannel(cliVersion)}, ${formatInstallMethodLabel(getCliInstallMethod()).toLowerCase()})\n`,
          );
          return 0;
        },
      );
    });

  const connectCommand = program
    .command("connect [source]")
    .description("Connect a source and collect data")
    .option("--json", "Output machine-readable JSON")
    .option("--no-input", "Fail instead of prompting for input")
    .option("--ipc", "Use file-based IPC for credential prompts (for agents)")
    .option("--yes", "Approve safe setup prompts automatically")
    .option("--quiet", "Reduce non-essential output")
    .option("--detach", "Run in the background")
    .option(
      "--from <checkout>",
      "Run a Collection Profile connector from a data-connectors checkout",
    )
    .action(
      async (source: string | undefined, commandOptions: ConnectOptions) => {
        process.exitCode = await runCommandWithTelemetry(
          { ...telemetryBaseContext, command: "connect", source },
          async () => {
            if (commandOptions.from && (!source || parsedOptions.detach)) {
              process.stderr.write(
                "--from needs a source and cannot be combined with --detach.\n",
              );
              return CliExitCode.USAGE;
            }
            if (parsedOptions.detach && source) {
              return runDetached("connect", source, parsedOptions);
            }
            return source
              ? runConnect(source, parsedOptions, { from: commandOptions.from })
              : runConnectEntry(parsedOptions);
          },
        );
      },
    );
  connectCommand.addHelpText(
    "after",
    `
Examples:
  vana connect
  vana connect github
  vana connect github --json --no-input
  vana connect github --json --ipc
  vana connect instinct --from ~/src/data-connectors
  vana connectors add instinct --from ~/src/data-connectors
`,
  );

  const connectors = program
    .command("connectors")
    .description(
      "Register Collection Profile connectors from a local directory",
    );
  connectors.addHelpText(
    "after",
    `
A registered connector runs its source unsigned, straight from the directory,
for every later \`vana connect <key>\`, \`vana collect\`, schedule and MCP call.
Only register directories you trust.

Examples:
  vana connectors add slack_browser --from ~/src/data-connectors
  vana connectors list
  vana connectors remove slack_browser
`,
  );
  connectors.action(() => {
    connectors.outputHelp();
  });

  connectors
    .command("add <key>")
    .description("Register a connector from a directory on this machine")
    .option(
      "--from <dir>",
      "Directory with connectors/<key>/index.ts and its manifest",
    )
    .option("--path <dir>", "Alias for --from")
    .option(
      "--force",
      "Register even when the key collides with a pinned or legacy connector",
    )
    .option("--json", "Output machine-readable JSON")
    .action(async (key: string, addOptions: ConnectorsAddOptions) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "connectors", subcommand: "add" },
        async () => runConnectorsAdd(key, addOptions, parsedOptions),
      );
    });

  connectors
    .command("list")
    .description("Show registered local connectors")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "connectors", subcommand: "list" },
        async () => runConnectorsList(parsedOptions),
      );
    });

  connectors
    .command("remove <key>")
    .description("Forget a registered local connector")
    .option("--json", "Output machine-readable JSON")
    .action(async (key: string) => {
      process.exitCode = await runCommandWithTelemetry(
        {
          ...telemetryBaseContext,
          command: "connectors",
          subcommand: "remove",
        },
        async () => runConnectorsRemove(key, parsedOptions),
      );
    });

  const sourcesCommand = program
    .command("sources [source]")
    .description("List supported sources, or show detail for one source")
    .option("--json", "Output machine-readable JSON")
    .action(async (source?: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "sources", source },
        async () =>
          source
            ? runSourceDetail(source, parsedOptions)
            : runList(parsedOptions),
      );
    });
  sourcesCommand.addHelpText(
    "after",
    `
Examples:
  vana sources
  vana sources github
  vana sources --json | jq '.sources'
`,
  );

  const collectCommand = program
    .command("collect [source]")
    .description("Re-collect data from a previously connected source")
    .option("--json", "Output machine-readable JSON")
    .option("--no-input", "Fail instead of prompting for input")
    .option("--ipc", "Use file-based IPC for credential prompts (for agents)")
    .option("--yes", "Approve safe setup prompts automatically")
    .option("--quiet", "Reduce non-essential output")
    .option("--detach", "Run in the background")
    .option("--all", "Collect from all connected sources")
    .action(async (source?: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "collect", source },
        async () => {
          if (parsedOptions.detach && source) {
            return runDetached("collect", source, parsedOptions);
          }
          return source
            ? runCollect(source, parsedOptions)
            : runCollectAll(parsedOptions);
        },
      );
    });
  collectCommand.addHelpText(
    "after",
    `
Examples:
  vana collect github
  vana collect
  vana collect --json
`,
  );

  const statusCommand = program
    .command("status")
    .description("Show runtime and Personal Server status")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "status" },
        async () => runStatus(parsedOptions),
      );
    });
  statusCommand.addHelpText(
    "after",
    `
Examples:
  vana status
  vana status --json | jq
`,
  );

  const doctorCommand = program
    .command("doctor")
    .description("Inspect local CLI, runtime, and install health")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "doctor" },
        async () => runDoctor(parsedOptions),
      );
    });
  doctorCommand.addHelpText(
    "after",
    `
Examples:
  vana doctor
  vana doctor --json | jq
`,
  );

  const setupCommand = program
    .command("setup")
    .description("Install or repair the local runtime")
    .option("--json", "Output machine-readable JSON")
    .option("--yes", "Approve safe setup prompts automatically")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "setup" },
        async () => runSetup(parsedOptions),
      );
    });
  setupCommand.addHelpText(
    "after",
    `
Examples:
  vana setup
  vana setup --yes
`,
  );

  const data = program
    .command("data")
    .description("Inspect collected datasets, paths, and summaries");
  data.addHelpText(
    "after",
    `
Examples:
  vana data list
  vana data show github
  vana data path github --json
`,
  );
  data.action(() => {
    data.outputHelp();
    process.exitCode = 0;
  });

  const dataListCommand = data
    .command("list")
    .description("List locally available collected datasets")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "data", subcommand: "list" },
        async () => runDataList(parsedOptions),
      );
    });
  dataListCommand.addHelpText(
    "after",
    `
Examples:
  vana data list
  vana data list --json | jq '.datasets'
`,
  );

  const dataShowCommand = data
    .command("show <source>")
    .description("Show a collected dataset")
    .option("--json", "Output machine-readable JSON")
    .action(async (source: string) => {
      process.exitCode = await runCommandWithTelemetry(
        {
          ...telemetryBaseContext,
          command: "data",
          subcommand: "show",
          source,
        },
        async () => runDataShow(source, parsedOptions),
      );
    });
  dataShowCommand.addHelpText(
    "after",
    `
Examples:
  vana data show github
  vana data show github --json | jq '.summary'
`,
  );

  const dataPathCommand = data
    .command("path <source>")
    .description("Print the local path for a collected dataset")
    .option("--json", "Output machine-readable JSON")
    .action(async (source: string) => {
      process.exitCode = await runCommandWithTelemetry(
        {
          ...telemetryBaseContext,
          command: "data",
          subcommand: "path",
          source,
        },
        async () => runDataPath(source, parsedOptions),
      );
    });
  dataPathCommand.addHelpText(
    "after",
    `
Examples:
  vana data path github
  vana data path github --json | jq -r '.path'
`,
  );

  const logsCommand = program
    .command("logs [source]")
    .description("Inspect stored connector run logs")
    .option("--json", "Output machine-readable JSON")
    .action(async (source?: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "logs", source },
        async () => runLogs(source, parsedOptions),
      );
    });
  logsCommand.addHelpText(
    "after",
    `
Examples:
  vana logs
  vana logs github
  vana logs github --json | jq
`,
  );

  const server = program
    .command("server")
    .description("Manage Personal Server connection")
    .option("--json", "Output machine-readable JSON");
  server.addHelpText(
    "after",
    `
Examples:
  vana server
  vana server start
  vana server start --foreground
  vana server stop
  vana server set-url http://localhost:8080
  vana server set-url https://ps-abc123.server.vana.org
  vana server clear-url
`,
  );
  server.action(async () => {
    process.exitCode = await runCommandWithTelemetry(
      { ...telemetryBaseContext, command: "server", subcommand: "status" },
      async () => runServerStatus(parsedOptions),
    );
  });

  server
    .command("status")
    .description(
      "Where your data is served from, where it is stored, and old registrations",
    )
    .option("--all", "Also list old registrations that no longer answer")
    .option("--json", "Output machine-readable JSON")
    .action(async (statusOptions: { all?: boolean }) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "status" },
        async () => runServerStatus(parsedOptions, statusOptions),
      );
    });

  server
    .command("set-url <url>")
    .description("Save a Personal Server URL")
    .option("--json", "Output machine-readable JSON")
    .action(async (url: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "set-url" },
        async () => runServerSetUrl(url, parsedOptions),
      );
    });

  server
    .command("clear-url")
    .description("Remove the saved Personal Server URL")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "clear-url" },
        async () => runServerClearUrl(parsedOptions),
      );
    });

  server
    .command("start")
    .description(
      "Run your own Personal Server in the background (no Vana Desktop needed); stop with `vana server stop`",
    )
    .option(
      "--port <port>",
      "Port to listen on (its neighbour hosts the approval page)",
    )
    .option(
      "--local",
      "Stay local only: no public URL, no on-chain registration, apps cannot reach it",
    )
    .option(
      "--foreground",
      "Stay in this terminal with the server's logs; stop with Ctrl+C",
    )
    .option("--detach", "Run in the background (the default)")
    .option("--json", "Output machine-readable JSON")
    .action(
      async (startOptions: {
        port?: string;
        local?: boolean;
        foreground?: boolean;
      }) => {
        process.exitCode = await runCommandWithTelemetry(
          { ...telemetryBaseContext, command: "server", subcommand: "start" },
          async () => {
            const port = startOptions.port
              ? Number(startOptions.port)
              : undefined;
            if (
              port !== undefined &&
              !(Number.isInteger(port) && port > 0 && port < 65535)
            ) {
              process.stderr.write("--port needs a port number.\n");
              return CliExitCode.USAGE;
            }
            return runServerStart(
              {
                network: resolveNetwork(parsedOptions.network).name,
                port,
                noInput: parsedOptions.noInput,
                yes: parsedOptions.yes,
                local: startOptions.local,
                // In the background unless asked to stay: `vana login` starts
                // it that way too, and the server outlives the terminal.
                detach: !startOptions.foreground,
              },
              serverStartIo(parsedOptions),
            );
          },
        );
      },
    );

  server
    .command("stop")
    .description("Stop the Personal Server `vana server start` runs here")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "stop" },
        async () => {
          const network = resolveNetwork(parsedOptions.network).name;
          // Stopping needs no live session: the account is the one signed in
          // last, expired or not.
          const account = readStoredAccountAddress();
          const { target, others } = serverToStop(
            runningCliServers(network),
            account,
          );
          const result = target
            ? await stopLocalServer(target.dir)
            : "not-running";
          if (parsedOptions.json) {
            process.stdout.write(
              `${JSON.stringify({
                type: "server-stop",
                result,
                network,
                owner: target?.owner ?? null,
                stillRunning: others.map((other) => ({
                  owner: other.owner,
                  pid: other.pid,
                })),
              })}\n`,
            );
          } else {
            const lines = [
              result === "stopped"
                ? `Stopped${target?.owner ? ` the Personal Server of ${target.owner}` : ""}.`
                : result === "not-running"
                  ? `No Personal Server ${account && account !== "env" ? `of ${account} ` : ""}started by vana is running (${network}).`
                  : "The server did not stop in time.",
              ...others.map(
                (other) =>
                  `vana still runs the Personal Server of ${other.owner ?? "another account"} (pid ${other.pid}); sign in as that account to stop it.`,
              ),
            ];
            process.stderr.write(`${lines.join("\n")}\n`);
          }
          return result === "timeout" ? CliExitCode.FAILURE : CliExitCode.OK;
        },
      );
    });

  server
    .command("sync")
    .description("Sync all local-only datasets to your Personal Server")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "sync" },
        async () => runServerSync(parsedOptions),
      );
    });

  server
    .command("data [scope]")
    .description("List scopes stored in your Personal Server")
    .option("--json", "Output machine-readable JSON")
    .action(async (scope?: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "server", subcommand: "data" },
        async () => runServerData(scope, parsedOptions),
      );
    });

  program
    .command("login")
    .description("Log in to your Vana account or a self-hosted Personal Server")
    .option("-s, --server <url>", "Self-hosted Personal Server URL")
    .option("--client-id <id>", "OAuth public client ID for Vana Account login")
    .action(async (loginOptions: LoginCommandOptions) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "login" },
        async () =>
          runLogin(parsedOptions, loginOptions.server, loginOptions.clientId),
      );
    });

  program
    .command("logout")
    .description("Log out and remove saved credentials")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "logout" },
        async () => runLogout(parsedOptions),
      );
    });

  const telemetry = program
    .command("telemetry")
    .description("Inspect and manage CLI telemetry");
  telemetry.action(async () => {
    process.exitCode = await runTelemetryStatus(parsedOptions);
  });

  telemetry
    .command("status")
    .description("Show telemetry state")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runTelemetryStatus(parsedOptions);
    });

  telemetry
    .command("enable")
    .description("Enable telemetry")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runTelemetryEnable(parsedOptions);
    });

  telemetry
    .command("disable")
    .description("Disable telemetry")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runTelemetryDisable(parsedOptions);
    });

  program
    .command("mcp")
    .description("Start MCP server for agent integration")
    .action(async () => {
      process.exitCode = await runLongRunningCommandWithTelemetry(
        { ...telemetryBaseContext, command: "mcp" },
        async () => {
          const { startMcpServer } = await import("./mcp-server.js");
          await startMcpServer();
        },
      );
    });

  const skill = program
    .command("skills")
    .description("Manage agent skills")
    .option("--json", "Output as JSON");
  skill.addHelpText(
    "after",
    `
Examples:
  vana skills list
  vana skills install connect-data
  vana skills show connect-data
`,
  );
  skill.action(async () => {
    process.exitCode = await runCommandWithTelemetry(
      { ...telemetryBaseContext, command: "skills" },
      async () => runSkillsGuidedPicker(parsedOptions),
    );
  });

  skill
    .command("list")
    .description("List available agent skills")
    .option("--json", "Output as JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "skills", subcommand: "list" },
        async () => runSkillList(parsedOptions),
      );
    });

  skill
    .command("install <name>")
    .description("Install a skill for your agent")
    .action(async (name: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "skills", subcommand: "install" },
        async () => runSkillInstall(name, parsedOptions),
      );
    });

  skill
    .command("show <name>")
    .description("Show skill details")
    .action(async (name: string) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "skills", subcommand: "show" },
        async () => runSkillShow(name, parsedOptions),
      );
    });

  // --- Schedule commands ---
  const schedule = program
    .command("schedule")
    .description("Manage scheduled data collection");
  schedule.addHelpText(
    "after",
    `
Examples:
  vana schedule add
  vana schedule add --every 12h
  vana schedule list
  vana schedule remove
`,
  );
  schedule.action(() => {
    schedule.outputHelp();
    process.exitCode = 0;
  });

  schedule
    .command("add")
    .description("Add a scheduled collection")
    .option(
      "--every <interval>",
      "Collection interval (e.g. 24h, 12h, 1h); default 24h, or the existing schedule's",
    )
    .action(async (opts: { every?: string }) => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "schedule", subcommand: "add" },
        async () => runScheduleAdd(opts.every, parsedOptions),
      );
    });

  schedule
    .command("list")
    .description("Show scheduled tasks")
    .option("--json", "Output machine-readable JSON")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "schedule", subcommand: "list" },
        async () => runScheduleList(parsedOptions),
      );
    });

  schedule
    .command("remove")
    .description("Remove the scheduled collection")
    .action(async () => {
      process.exitCode = await runCommandWithTelemetry(
        { ...telemetryBaseContext, command: "schedule", subcommand: "remove" },
        async () => runScheduleRemove(parsedOptions),
      );
    });

  registerAppCommands(program, () => parsedOptions);

  applyGlobalOptions(program);

  try {
    await program.parseAsync(normalizedArgv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.help" ||
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        process.exitCode = error.exitCode;
        return Number(process.exitCode ?? 0);
      }
      // Commander already printed to stderr. Usage errors (unknown command
      // or option, missing or invalid argument) exit 2 per the exit-code
      // table in docs/CLI-EXIT-CODE-MATRIX.md; anything else keeps
      // commander's own code.
      process.exitCode = error.code.startsWith("commander.")
        ? CliExitCode.USAGE
        : error.exitCode;
      return Number(process.exitCode ?? 1);
    }
    if (isPromptInputClosed(error)) {
      // A prompt nobody can answer: say so instead of dying mid-question.
      process.stderr.write(`\n${(error as Error).message}\n`);
      process.exitCode = CliExitCode.CONFIRMATION_REQUIRED;
      return CliExitCode.CONFIRMATION_REQUIRED;
    }
    throw error;
  }

  // Show update notification if a newer version is available.
  // The concurrent check may have populated the cache during this run.
  if (shouldNotify) {
    try {
      await Promise.race([
        updateCheckPromise,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      const cache = await readUpdateCheck();
      if (cache && isNewerVersion(cliVersion, cache.latestVersion)) {
        const { upgrade } = getLifecycleCommands(
          installMethod,
          getCliChannel(cliVersion),
        );
        process.stderr.write(
          `\nUpdate available: ${cliVersion} → ${cache.latestVersion}\nRun: ${upgrade}\n`,
        );
      }
    } catch {
      // Never block exit for update notification failures
    }
  }

  return Number(process.exitCode ?? 0);
}

function classifyCommandFailure(error: unknown): string {
  if (error instanceof Error) {
    const value = error.message.toLowerCase();
    if (
      value.includes("needs_input") ||
      value.includes("needs input") ||
      value.includes("input required") ||
      value.includes("manual step")
    )
      return "needs_input";
    if (value.includes("prompt_cancelled") || value.includes("cancelled"))
      return "prompt_cancelled";
    if (
      value.includes("personal_server_unavailable") ||
      value.includes("personal server unavailable")
    )
      return "personal_server_unavailable";
    if (value.includes("auth expired")) return "auth_expired";
    if (value.includes("auth")) return "auth_failed";
    if (value.includes("setup")) return "setup_required";
    if (value.includes("timeout") || value.includes("timed out"))
      return "timeout";
    if (value.includes("network")) return "network_error";
    if (value.includes("runtime")) return "runtime_error";
    if (value.includes("connector")) return "connector_unavailable";
    if (value.includes("ingest")) return "ingest_failed";
  }
  return "unknown";
}

async function runCommandWithTelemetry(
  context: {
    command: string;
    subcommand?: string;
    source?: string;
    cliVersion: string;
    channel: CliChannel;
    installMethod: CliInstallMethod;
    options: GlobalOptions;
    localOnly?: boolean;
  },
  action: () => Promise<number>,
): Promise<number> {
  const session = await createCliTelemetrySession({
    ...context,
    options: {
      json: Boolean(context.options.json),
      noInput: Boolean(context.options.noInput),
      quiet: Boolean(context.options.quiet),
      detach: Boolean(context.options.detach),
      ipc: Boolean(context.options.ipc),
    },
    localOnly: context.localOnly,
  });

  setActiveTelemetrySession(session);
  await flushTelemetryOutbox();

  try {
    const exitCode = await action();
    session.markCommandResult({ exitCode });
    return exitCode;
  } catch (error) {
    session.markCommandResult({
      exitCode: 1,
      errorClass: classifyCommandFailure(error),
    });
    throw error;
  } finally {
    await session.persist();
    await session.flush();
    setActiveTelemetrySession(null);
  }
}

async function runLongRunningCommandWithTelemetry(
  context: {
    command: string;
    subcommand?: string;
    source?: string;
    cliVersion: string;
    channel: CliChannel;
    installMethod: CliInstallMethod;
    options: GlobalOptions;
  },
  action: () => Promise<void>,
): Promise<number> {
  const session = await createCliTelemetrySession({
    ...context,
    options: {
      json: Boolean(context.options.json),
      noInput: Boolean(context.options.noInput),
      quiet: Boolean(context.options.quiet),
      detach: Boolean(context.options.detach),
      ipc: Boolean(context.options.ipc),
    },
  });

  setActiveTelemetrySession(session);
  await flushTelemetryOutbox();
  session.trackCustomEvent("mcp_started");
  session.markCommandResult({ exitCode: 0, outcome: "started" });
  await session.persist();
  await session.flush();

  try {
    await action();
    return 0;
  } finally {
    setActiveTelemetrySession(null);
  }
}

async function runTelemetryStatus(options: GlobalOptions): Promise<number> {
  const status = await getTelemetryStatus();
  const endpointHost = (() => {
    try {
      return new URL(status.endpoint).host;
    } catch {
      return status.endpoint;
    }
  })();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return 0;
  }

  const emit = createEmitter(options);
  emit.title("Telemetry");
  emit.blank();
  emit.keyValue("Enabled", status.enabled ? "yes" : "no");
  emit.keyValue("Mode", status.mode);
  emit.keyValue("Reason", status.reason.replaceAll("_", " "));
  emit.keyValue("Endpoint", endpointHost);
  emit.keyValue("Queued", String(status.queuedBatches));
  emit.detail(
    "Collected data stays local. Remote telemetry only includes small operational events.",
  );
  if (status.enabled) {
    emit.detail(`Disable with: ${emit.code("vana telemetry disable")}`);
  } else {
    emit.detail(`Enable with: ${emit.code("vana telemetry enable")}`);
  }
  if (process.env.VANA_TELEMETRY_DEBUG === "1") {
    emit.detail(
      `Debug mode is active via ${emit.code("VANA_TELEMETRY_DEBUG=1")}. Events print to stderr and are not uploaded.`,
    );
  }
  if (process.env.VANA_TELEMETRY_DISABLED === "1") {
    emit.detail(
      `Telemetry is currently overridden by ${emit.code("VANA_TELEMETRY_DISABLED=1")}.`,
    );
  }
  return 0;
}

async function runTelemetryEnable(options: GlobalOptions): Promise<number> {
  await setTelemetryEnabled(true);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ enabled: true })}\n`);
    return 0;
  }

  const emit = createEmitter(options);
  emit.success("Telemetry enabled.");
  if (process.env.VANA_TELEMETRY_DISABLED === "1") {
    emit.detail(
      `The current shell still disables uploads via ${emit.code("VANA_TELEMETRY_DISABLED=1")}.`,
    );
  }
  return 0;
}

async function runTelemetryDisable(options: GlobalOptions): Promise<number> {
  await setTelemetryEnabled(false);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ enabled: false })}\n`);
    return 0;
  }

  const emit = createEmitter(options);
  emit.success("Telemetry disabled.");
  return 0;
}

/**
 * How long a phase may stay silent before it gets a spinner.
 *
 * Connect is deliberately quiet when everything is warm, so a line appears
 * only once a phase outlives this. Past it the terminal would otherwise sit
 * blank while the CLI waits on the network, on Chromium, or on a page load.
 */
const PHASE_PROGRESS_DELAY_MS = 400;

interface PhaseProgress {
  /** The phase succeeded: stop the timer, tick the line if one was drawn. */
  settle(): void;
  /**
   * The phase failed: stop the timer but leave any drawn line active, so the
   * renderer's own `fail` turns it into the cross that explains where it died.
   */
  abandon(): void;
}

function startPhaseProgress(
  renderer: ConnectRenderer | null,
  label: string,
  delayMs = PHASE_PROGRESS_DELAY_MS,
): PhaseProgress {
  if (!renderer) {
    return { settle() {}, abandon() {} };
  }
  let drawn = false;
  let finished = false;
  const timer = setTimeout(() => {
    drawn = true;
    renderer.scopeActive(label);
  }, delayMs);
  timer.unref?.();
  return {
    settle() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (drawn) renderer.scopeDone(label);
    },
    abandon() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
    },
  };
}

export async function withPhaseProgress<T>(
  renderer: ConnectRenderer | null,
  label: string,
  work: () => Promise<T>,
  delayMs = PHASE_PROGRESS_DELAY_MS,
): Promise<T> {
  const progress = startPhaseProgress(renderer, label, delayMs);
  try {
    const result = await work();
    progress.settle();
    return result;
  } catch (error) {
    progress.abandon();
    throw error;
  }
}

interface ConnectOptions {
  /** A data-connectors checkout to run a Collection Profile connector from. */
  from?: string;
  /** How the flow is titled; `vana collect` says Collect. */
  verb?: "Connect" | "Collect";
}

interface ConnectorsAddOptions {
  from?: string;
  /** Alias for `from`. */
  path?: string;
  force?: boolean;
}

/**
 * Ids the catalog lists on its own, without local entries, so `connectors
 * add` can tell when a key would shadow a pinned or legacy connector.
 */
async function loadCatalogIds(): Promise<string[]> {
  try {
    const sources = await listAvailableSources(
      findDataConnectorsDir() ?? undefined,
      { readLocalConnectors: async () => ({}) },
    );
    return sources.map((source) => source.id);
  } catch {
    return [];
  }
}

async function runConnectorsAdd(
  rawKey: string,
  addOptions: ConnectorsAddOptions,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const key = rawKey.toLowerCase();
  const dir = addOptions.from ?? addOptions.path;
  if (!dir) {
    const message = "connectors add needs --from <dir>.";
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: "usage", key, message })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return CliExitCode.USAGE;
  }

  let result: Awaited<ReturnType<typeof addLocalConnector>>;
  try {
    result = await addLocalConnector(key, dir, {
      force: Boolean(addOptions.force),
      catalogIds: await loadCatalogIds(),
    });
  } catch (error) {
    const conflict = error instanceof LocalConnectorConflictError;
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: conflict ? "conflict" : "invalid_connector",
          key,
          ...(conflict ? { conflicts: error.conflicts } : {}),
          message,
        })}\n`,
      );
    } else {
      emit.info(message);
    }
    return 1;
  }

  const { entry, conflicts, replaced } = result;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, key, ...entry, replaced, conflicts })}\n`,
    );
    return 0;
  }

  emit.info(
    `${replaced ? "Updated" : "Registered"} ${key} (${entry.displayName} ${entry.version}) from ${entry.path}`,
  );
  if (entry.gitHead) {
    emit.detail(`At commit ${entry.gitHead.slice(0, 12)}.`);
  }
  if (conflicts.length > 0) {
    emit.info(
      `Warning: ${key} shadows ${conflicts
        .map((conflict) =>
          conflict === "pinned"
            ? "a pinned Collection Profile connector"
            : "a legacy registry connector",
        )
        .join(
          " and ",
        )}. It shares that connector's state, browser profile and scope names.`,
    );
  }
  emit.detail(
    "Every run executes this directory's source unsigned. Remove it with `vana connectors remove` when you are done.",
  );
  emit.blank();
  emit.next(`vana connect ${key}`);
  return 0;
}

async function runConnectorsList(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const entries = await readLocalConnectors();
  const connectors = Object.entries(entries)
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((left, right) => left.key.localeCompare(right.key));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ count: connectors.length, connectors })}\n`,
    );
    return 0;
  }

  emit.title("Local connectors");
  emit.blank();
  if (connectors.length === 0) {
    emit.info("No local connectors are registered.");
    emit.detail(
      `Register one with ${emit.code("vana connectors add <key> --from <dir>")}.`,
    );
    return 0;
  }

  const keyWidth = Math.max(...connectors.map((entry) => entry.key.length));
  const versionWidth = Math.max(
    ...connectors.map((entry) => entry.version.length),
  );
  for (const entry of connectors) {
    const head = entry.gitHead ? `  (git ${entry.gitHead.slice(0, 12)})` : "";
    emit.info(
      `  ${entry.key.padEnd(keyWidth)}  ${entry.version.padEnd(versionWidth)}  ${formatDisplayPath(entry.path)}${head}`,
    );
  }
  emit.blank();
  emit.detail("Each runs its directory's source unsigned on every collect.");
  return 0;
}

async function runConnectorsRemove(
  rawKey: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const key = rawKey.toLowerCase();
  const removed = await removeLocalConnector(key);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, key, removed })}\n`);
    return 0;
  }

  if (removed) {
    emit.info(`Removed local connector ${key}.`);
    emit.detail(
      "Collected data and state stay on disk; connect again to use a pinned or legacy connector with this key.",
    );
  } else {
    emit.info(`No local connector named ${key} is registered.`);
  }
  return 0;
}

/**
 * The scopes a local connector produces: one per manifest stream, named
 * `<key>.<stream>` the way ingest files them.
 */
async function readLocalConnectorScopes(
  dir: string,
  key: string,
): Promise<Array<{ scope: string; label: string; description?: string }>> {
  try {
    const { profile } = await readLocalProfile(dir, key);
    return profile.streams.map((stream) => ({
      scope: `${key}.${stream.name}`,
      label: stream.display?.label ?? `${key}.${stream.name}`,
    }));
  } catch {
    return [];
  }
}

/**
 * True when no person can confirm storing data in another account's server:
 * --no-input, --yes (which must not say yes to that), --ipc (an agent drives
 * the run), or a scheduled run.
 */
function cannotAskAboutForeignServer(options: GlobalOptions): boolean {
  return Boolean(
    options.noInput ||
    options.yes ||
    options.ipc ||
    process.env[SCHEDULED_RUN_ENV] === "1",
  );
}

/** Why data was not stored in the server answering here. */
function foreignServerRefusal(url: string | null, owner: string): string {
  return `Not storing your data: the Personal Server at ${url ?? "this machine"} belongs to ${formatAddress(owner)}, not to you. Start yours with \`vana server start\`, or run this without --no-input or --yes to choose.`;
}

async function runConnect(
  rawSource: string,
  options: GlobalOptions,
  connectOptions: ConnectOptions = {},
): Promise<number> {
  const source = rawSource.toLowerCase();
  const pdppSource = await resolvePdppSource(source, {
    from: connectOptions.from,
  });
  const isPdpp = pdppSource !== null;
  const emit = createEmitter(options);
  const renderer: ConnectRenderer | null =
    !options.json && !options.quiet
      ? createConnectRenderer(connectOptions.verb)
      : null;
  const registrySources = await loadRegistrySources();
  const sourceLabels = createSourceLabelMap(registrySources);
  const displayName = displaySource(source, sourceLabels);
  let setupLogPath: string | undefined;
  let fetchLogPath: string | undefined;
  let runLogPath: string | undefined;
  let pendingExitCode: number | null = null;

  try {
    // Title
    renderer?.title(displayName);

    const target = await withPhaseProgress(
      renderer,
      "Finding your Personal Server",
      () => detectPersonalServerTarget(),
    );

    // Collecting into a server owned by another identity looks like success
    // and is not undoable, so settle ownership before touching the source.
    const credentials = loadCredentials();
    const mismatch = personalServerOwnerMismatch(
      target.health?.owner,
      credentials?.account?.address,
    );
    if (mismatch) {
      // An expired login names whoever signed in last, which may be long
      // gone; say that, rather than claim a current identity.
      renderer?.detail(
        credentials && isExpired(credentials)
          ? `Your vana login has expired, so the CLI cannot check that the Personal Server at ${target.url} (owner ${formatAddress(mismatch.owner)}) is yours. Run \`vana login\` to check.`
          : `The Personal Server at ${target.url} belongs to ${formatAddress(mismatch.owner)}, but you are signed in as ${formatAddress(mismatch.account)}.`,
      );
      if (cannotAskAboutForeignServer(options)) {
        // Nobody is there to say yes: never store one account's data in
        // another account's server on its own (the nightly schedule runs
        // exactly like this).
        const message = foreignServerRefusal(target.url, mismatch.owner);
        renderer?.fail(message);
        if (!renderer && !options.json) process.stderr.write(`${message}\n`);
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.PERSONAL_SERVER_UNAVAILABLE,
          source,
          reason: "personal_server_not_yours",
          personalServerUrl: target.url,
          personalServerOwner: mismatch.owner,
          account: mismatch.account,
          message,
        });
        return CliExitCode.SERVER_UNAVAILABLE;
      } else {
        renderer?.cleanup();
        const useIt = await confirm({
          message: `Store your ${displayName} data in ${formatAddress(mismatch.owner)}'s Personal Server?`,
          default: false,
          ...vanaPromptTheme,
        });
        if (!useIt) {
          renderer?.fail("Cancelled.");
          renderer?.detail(
            "Sign in as that identity, or start the Personal Server for this one, then run `vana connect` again.",
          );
          return CliExitCode.CONFIRMATION_REQUIRED;
        }
      }
    }

    // Collection Profile state is kept per server owner, so it has to be
    // settled here, after the server is known.
    const runtime = isPdpp
      ? new PdppRuntime({
          from: connectOptions.from,
          owner: target.health?.owner ?? loadCredentials()?.account?.address,
        })
      : new ManagedPlaywrightRuntime();

    // --- Phase 1: Runtime check (silent if installed) ---
    if (runtime.state !== "installed") {
      if (options.noInput) {
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.SETUP_REQUIRED,
          source,
        });
        renderer?.fail(
          `${displayName} needs a local browser runtime. Run without --no-input to install.`,
        );
        return 1;
      }

      if (!options.yes) {
        renderer?.cleanup();
        process.stderr.write("\n");
        process.stderr.write("Vana Connect needs a local runtime.\n\n");
        process.stderr.write("This will install:\n");
        for (const line of runtime.installSummary.lines) {
          process.stderr.write(`  \u2022 ${line}\n`);
        }
        process.stderr.write("  \u2022 Local files under ~/.vana/\n\n");
        process.stderr.write("Your credentials stay on this machine.\n\n");

        const shouldContinue = await confirm({
          message: "Continue?",
          default: true,
          ...vanaPromptTheme,
        });
        if (!shouldContinue) {
          renderer?.fail("Cancelled.");
          emit.event({
            type: "outcome",
            status: CliOutcomeStatus.SETUP_REQUIRED,
            source,
            reason: "setup_declined",
          });
          return 1;
        }
        process.stderr.write("\n");
      }

      trackActiveTelemetryEvent("runtime_install_started", { source });
      let installResult: Awaited<ReturnType<typeof runtime.ensureInstalled>>;
      try {
        installResult = await withPhaseProgress(
          renderer,
          runtime.installSummary.phase,
          () => runtime.ensureInstalled(Boolean(options.yes)),
        );
      } catch (error) {
        trackActiveTelemetryEvent("runtime_install_failed", {
          source,
          errorClass: classifyCommandFailure(error),
        });
        throw error;
      }
      setupLogPath = installResult.logPath;
      emit.event({
        type: "setup-complete",
        runtime: installResult.runtime,
        logPath: installResult.logPath,
      });
    } else {
      emit.event({
        type: "setup-check",
        runtime: runtime.state,
      });
    }

    // --- Phase 2: Connector fetch (silent if cached/fast) ---
    const preState = await readCliState();
    const currentVersion = preState.sources[source]?.connectorVersion;
    let fetched: Awaited<ReturnType<typeof runtime.fetchConnector>>;
    try {
      fetched = await withPhaseProgress(
        renderer,
        `Getting the ${displayName} connector`,
        () => runtime.fetchConnector(source, currentVersion),
      );
    } catch (firstError) {
      const firstMessage =
        firstError instanceof Error ? firstError.message : "";
      const isChecksumError =
        firstMessage.toLowerCase().includes("checksum") ||
        firstMessage.toLowerCase().includes("mismatch");

      // Auto-retry on stale cache: clear cached connector and re-fetch
      // from remote (skip local data-connectors dir which may be stale).
      // Collection Profiles verify against a signed digest instead, and a
      // failure there must never fall back to the legacy cache.
      if (isChecksumError && !isPdpp) {
        try {
          const cacheDir = getConnectorCacheDir();
          const sourceCacheDir = path.join(cacheDir, source);
          await fsp.rm(sourceCacheDir, { recursive: true, force: true });
          const resolution = await withPhaseProgress(
            renderer,
            "Cached connector looks stale, downloading a fresh one",
            () =>
              fetchConnectorToCache(
                source,
                cacheDir,
                undefined, // force remote fetch, skip local data-connectors
              ),
          );
          fetched = {
            connectorPath: resolution.connectorPath,
            logPath: "",
            version: resolution.version,
          };
        } catch (retryError) {
          const retryMessage =
            retryError instanceof Error
              ? retryError.message
              : `Could not fetch ${displayName} connector.`;
          const message = formatHumanSourceMessage(
            retryMessage,
            source,
            displayName,
          );
          await updateSourceState(source, {
            connectorInstalled: false,
            lastRunAt: new Date().toISOString(),
            lastRunOutcome: CliOutcomeStatus.CONNECTOR_UNAVAILABLE,
            lastError: message,
            lastLogPath: getErrorLogPath(retryError),
          });
          renderer?.fail(`${displayName} connector could not be verified.`);
          renderer?.detail(message);
          renderer?.detail(
            `Try again later, or report: https://github.com/PDP-Connect/data-connectors/issues`,
          );
          emit.event({
            type: "outcome",
            status: CliOutcomeStatus.CONNECTOR_UNAVAILABLE,
            source,
            reason: message,
          });
          return 1;
        }
      } else {
        const message = formatHumanSourceMessage(
          firstMessage ||
            `No connector is available for ${displayName} right now.`,
          source,
          displayName,
        );
        await updateSourceState(source, {
          connectorInstalled: false,
          lastRunAt: new Date().toISOString(),
          lastRunOutcome: CliOutcomeStatus.CONNECTOR_UNAVAILABLE,
          lastError: message,
          lastLogPath: getErrorLogPath(firstError),
        });
        renderer?.fail(`${displayName} is not available.`);
        renderer?.detail(`See what’s ready: vana sources`);
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.CONNECTOR_UNAVAILABLE,
          source,
          reason: message,
        });
        return 1;
      }
    }
    if (fetched.updated && fetched.previousVersion) {
      trackActiveTelemetryEvent("connector_update_applied", {
        source,
        metadata: {
          previousVersion: fetched.previousVersion,
          connectorVersion: fetched.version,
        } as Record<string, string>,
      });
      renderer?.detail(
        `Updated connector (${fetched.previousVersion} → ${fetched.version}).`,
      );
    }
    fetchLogPath = fetched.logPath;
    const sourceDetails = registrySources.find((item) => item.id === source);
    const resolution = {
      source,
      connectorPath: fetched.connectorPath,
    } as const;
    emit.event({
      type: "connector-resolved",
      source: resolution.source,
      connectorPath: resolution.connectorPath,
      ...(fetched.version ? { connectorVersion: fetched.version } : {}),
      logPath: fetched.logPath,
    });
    trackActiveTelemetryEvent("connector_version_detected", {
      source: resolution.source,
      connectorVersion: fetched.version,
    });

    // --- Phase 3: Pre-connection validation (silent) ---
    const profilePath = isPdpp
      ? path.join(getPdppProfileRoot(), source)
      : path.join(
          getBrowserProfilesDir(),
          `${path.basename(resolution.connectorPath, path.extname(resolution.connectorPath))}`,
        );

    if (
      sourceDetails?.authMode === "legacy" &&
      !options.noInput &&
      process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY
    ) {
      const message =
        "This source needs a manual browser step, but no local display server is available.";
      await updateSourceState(resolution.source, {
        connectorInstalled: true,
        sessionPresent: fs.existsSync(profilePath),
        lastRunAt: new Date().toISOString(),
        lastRunOutcome: CliOutcomeStatus.LEGACY_AUTH,
        lastError: message,
        lastLogPath: fetchLogPath ?? null,
      });
      renderer?.fail(
        `${displayName} requires a browser window, but no display is available.`,
      );
      renderer?.detail("Run this command in a desktop terminal.");
      emit.event({
        type: "outcome",
        status: CliOutcomeStatus.LEGACY_AUTH,
        source: resolution.source,
        reason: "display_server_unavailable",
      });
      return 1;
    }

    await updateSourceState(resolution.source, {
      connectorInstalled: true,
      sessionPresent: fs.existsSync(profilePath),
      lastError: null,
      lastLogPath: fetchLogPath ?? null,
    });

    // --- Phase 4-5: Authentication + Collection ---
    let finalStatus: CliOutcome["status"] =
      CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR;
    let finalDataState: SourceStatus["dataState"] = "none";
    let ingestFailureMessage: string | null = null;
    let resultPath = getSourceResultPath(source);
    let collectedResult = false;
    let blockedByRequiredInput = false;
    const skippedStreams: Array<{
      stream?: string;
      reason?: string;
      message?: string;
    }> = [];
    let ingestScopeResults:
      | Array<{
          scope: string;
          status: "stored" | "failed";
          syncedAt?: string;
          error?: string;
        }>
      | undefined;

    // Chromium start-up and the first page load happen before a connector
    // reports anything, which is the longest silent stretch of a warm run.
    const launchProgress = startPhaseProgress(
      renderer,
      `Opening ${displayName} in a browser`,
    );

    // In IPC mode (--ipc), don’t provide an interactive callback.
    // The runtime will write a pending-input file and poll for the
    // response, letting an external agent handle credential collection.
    const interactiveCallback = options.ipc
      ? undefined
      : async (needInput: {
          message?: string;
          fields: string[];
          schema?: { properties?: Record<string, unknown> };
          responseInputPath: string;
          kind?: string;
        }) => {
          // Settle first: a spinner repaint would overwrite the prompt.
          launchProgress.settle();
          renderer?.pauseForPrompt();

          // A manual step happens in the browser window the connector opened;
          // the prompt only waits for the person to say it is done.
          if (needInput.kind === "manual_action") {
            process.stderr.write(
              `\n${needInput.message ?? `Sign in to ${displayName} in the browser window.`}\n\n`,
            );
            let finished: boolean;
            try {
              finished = await confirm({
                message: "Done in the browser?",
                default: true,
                ...vanaPromptTheme,
              });
            } catch (error) {
              if (isPromptCancelled(error)) {
                throw new Error("__vana_prompt_cancelled__");
              }
              throw error;
            }
            if (!finished) {
              throw new Error("__vana_prompt_cancelled__");
            }
            process.stderr.write("\n");
            renderer?.resumeAfterPrompt();
            return {};
          }

          // Show connector’s prompt message
          if (renderer) {
            const promptMessage =
              needInput.message ?? `${displayName} needs your login.`;
            process.stderr.write(`\n${promptMessage}\n\n`);
          }

          const values: Record<string, string> = {};
          try {
            for (const field of needInput.fields) {
              const fieldSchema = needInput.schema?.properties?.[field] as
                | { format?: unknown }
                | undefined;
              const isPasswordField =
                field.toLowerCase().includes("password") ||
                fieldSchema?.format === "password";
              if (isPasswordField) {
                values[field] = await password({
                  message: humanizeField(field),
                  ...vanaPromptTheme,
                });
              } else {
                values[field] = await input({
                  message: humanizeField(field),
                  ...vanaPromptTheme,
                });
              }
            }
          } catch (error) {
            if (isPromptCancelled(error)) {
              throw new Error("__vana_prompt_cancelled__");
            }
            throw error;
          }
          if (renderer) {
            process.stderr.write("\n");
          }
          renderer?.resumeAfterPrompt();
          return values;
        };

    const shownBrowserPrompts = new Set<string>();
    for await (const event of runtime.runConnector({
      connectorPath: resolution.connectorPath,
      source: resolution.source,
      noInput: options.ipc ? false : options.noInput,
      onNeedInput: interactiveCallback,
    })) {
      emit.event(event);
      if (event.logPath) {
        runLogPath = event.logPath;
      }
      // status-update draws nothing, so it is not proof the browser is up.
      if (event.type !== "status-update") {
        launchProgress.settle();
      }

      if (pendingExitCode !== null && event.type !== "collection-complete") {
        continue;
      }

      if (event.type === "needs-input") {
        if (options.noInput && !options.ipc) {
          blockedByRequiredInput = true;
        }
        await updateSourceState(resolution.source, {
          lastRunAt: new Date().toISOString(),
          lastRunOutcome: CliOutcomeStatus.NEEDS_INPUT,
          lastError: event.message ?? "Input required.",
          lastLogPath: event.logPath,
          connectionHealth: "needs_reauth",
          connectionHealthChangedAt: new Date().toISOString(),
          connectionHealthReason: `needs-input: ${event.message ?? "Input required."}`,
          connectionHealthRetryable: false,
        });
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.NEEDS_INPUT,
          source: resolution.source,
        });
        renderer?.fail(
          `${displayName} needs credentials. Run without --no-input to authenticate.`,
        );
        pendingExitCode = 1;
      }

      if (event.type === "progress-update") {
        // Drive the renderer with scope information from the event
        const scopeName = extractScopeName(event);
        if (scopeName && renderer) {
          const isComplete =
            typeof event.message === "string" &&
            /^complete\b/i.test(event.message.trim());
          if (isComplete) {
            const detail = formatScopeDetail(event);
            renderer.scopeDone(scopeName, detail);
          } else {
            renderer.scopeActive(scopeName);
          }
        }
        continue;
      }

      if (event.type === "status-update") {
        // Status updates are silent in the new design
        continue;
      }

      if (event.type === "local-connector") {
        // Unsigned code is running; say where from, in every mode.
        if (event.message) renderer?.detail(event.message);
        continue;
      }

      if (event.type === "stream-skipped") {
        skippedStreams.push({
          stream: event.stream,
          reason: event.reason,
          message: event.message,
        });
        continue;
      }

      if (event.type === "runtime-error") {
        await updateSourceState(resolution.source, {
          lastRunAt: new Date().toISOString(),
          lastRunOutcome: CliOutcomeStatus.RUNTIME_ERROR,
          lastError: event.message ?? "Connector run failed.",
          lastLogPath: event.logPath,
          connectionHealth: "error",
          connectionHealthChangedAt: new Date().toISOString(),
          connectionHealthReason: `runtime-error: ${event.message ?? "Connector run failed."}`,
          connectionHealthRetryable:
            /timeout|ECONNREFUSED|ENOTFOUND|rate.?limit|50[234]|socket hang up/i.test(
              event.message ?? "",
            ),
        });
        renderer?.fail(`Problem connecting ${displayName}.`);
        renderer?.detail(event.message ?? "Connector run failed.");
        renderer?.detail(`Retry: vana connect ${source}`);
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.RUNTIME_ERROR,
          source: resolution.source,
        });
        pendingExitCode = 1;
        continue;
      }

      if (event.type === "headed-required") {
        // The browser opens by itself, but the person has to act in it:
        // without this line an empty sign-in page appears and the terminal
        // says nothing. Each distinct message once.
        const message = event.message?.trim();
        if (message && !shownBrowserPrompts.has(message)) {
          // The bell once per run: the runtime's "opening a browser" line and
          // the connector's own instruction arrive back to back.
          if (shownBrowserPrompts.size === 0) {
            renderer?.bell();
          }
          shownBrowserPrompts.add(message);
          renderer?.note(browserStepMessage(message));
        }
        continue;
      }

      if (event.type === "legacy-auth") {
        await updateSourceState(resolution.source, {
          lastRunAt: new Date().toISOString(),
          lastRunOutcome: CliOutcomeStatus.LEGACY_AUTH,
          lastError: event.message ?? "Legacy authentication is required.",
          lastLogPath: event.logPath,
          connectionHealth: "needs_reauth",
          connectionHealthChangedAt: new Date().toISOString(),
          connectionHealthReason: `legacy-auth: ${event.message ?? "Legacy authentication is required."}`,
          connectionHealthRetryable: false,
        });
        renderer?.fail(`Manual step required for ${displayName}.`);
        renderer?.detail(
          `Complete the browser step locally, then rerun vana connect ${source}.`,
        );
        emit.event({
          type: "outcome",
          status: CliOutcomeStatus.LEGACY_AUTH,
          source: resolution.source,
        });
        pendingExitCode = 1;
      }

      if (event.type === "collection-complete" && event.resultPath) {
        if (blockedByRequiredInput) {
          continue;
        }

        // Check if the result is actually an error object
        try {
          const raw = await fsp.readFile(event.resultPath, "utf8");
          const parsed = JSON.parse(raw);
          const errorOnly =
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            Object.keys(parsed).length <= 2;
          // A full export shape can also carry errors and no data: the
          // connector stopped (e.g. at sign-in) or every stream failed, and it
          // wrote an empty result, which must not read as "Connected".
          const fatalReason = errorOnly ? null : failedEmptyResult(parsed);
          if (errorOnly || fatalReason) {
            // Connector returned an error, not real data
            const errorMsg =
              fatalReason ??
              (typeof parsed.error === "string"
                ? parsed.error
                : "Collection returned an error");
            await updateSourceState(source, {
              lastRunAt: new Date().toISOString(),
              lastRunOutcome: CliOutcomeStatus.RUNTIME_ERROR,
              connectionHealth: "error",
              connectionHealthChangedAt: new Date().toISOString(),
              connectionHealthReason: `error-result: ${errorMsg}`,
              connectionHealthRetryable: false,
              lastError: errorMsg,
              lastLogPath: runLogPath ?? fetchLogPath,
            });
            renderer?.fail(`Problem connecting ${displayName}.`);
            renderer?.detail(
              fatalReason ??
                (typeof parsed.error === "string"
                  ? parsed.error
                  : "The connector returned an error instead of data."),
            );
            emit.event({
              type: "outcome",
              status: CliOutcomeStatus.RUNTIME_ERROR,
              source,
              reason: errorMsg,
            });
            pendingExitCode = 1;
            continue;
          }
        } catch (parseError) {
          const msg =
            parseError instanceof Error ? parseError.message : "Unknown error";
          await updateSourceState(source, {
            lastError: `Failed to parse result file (${event.resultPath}): ${msg}`,
          });
        }

        collectedResult = true;
        resultPath = event.resultPath;
        const ingestEvents = await withPhaseProgress(
          renderer,
          "Saving to your Personal Server",
          () => ingestResult(resolution.source, resultPath, target),
        );
        for (const ingestEvent of ingestEvents) {
          emit.event(ingestEvent);
        }

        const scopeResults = ingestEvents.find(
          (e) =>
            e.type === "ingest-complete" ||
            e.type === "ingest-partial" ||
            e.type === "ingest-failed",
        )?.scopeResults;

        const ingestCompleted = ingestEvents.some(
          (ingestEvent) => ingestEvent.type === "ingest-complete",
        );
        const ingestPartial = ingestEvents.some(
          (ingestEvent) => ingestEvent.type === "ingest-partial",
        );
        const ingestFailedEvent = ingestEvents.find(
          (ingestEvent) => ingestEvent.type === "ingest-failed",
        );
        const ingestSkippedUnavailable = ingestEvents.some(
          (ingestEvent) =>
            ingestEvent.type === "ingest-skipped" &&
            ingestEvent.reason === "personal_server_unavailable",
        );
        if (ingestCompleted) {
          finalStatus = CliOutcomeStatus.CONNECTED_AND_INGESTED;
          finalDataState = "ingested_personal_server";
        } else if (ingestPartial) {
          finalStatus = CliOutcomeStatus.CONNECTED_AND_INGESTED;
          finalDataState = "ingested_personal_server";
        } else if (ingestFailedEvent?.type === "ingest-failed") {
          finalStatus = CliOutcomeStatus.INGEST_FAILED;
          finalDataState = "ingest_failed";
          ingestFailureMessage =
            ingestFailedEvent.message ?? "Personal Server sync failed.";
        } else if (ingestSkippedUnavailable) {
          finalStatus = CliOutcomeStatus.CONNECTED_LOCAL_ONLY;
          finalDataState = "ingest_unavailable";
        } else {
          finalStatus = CliOutcomeStatus.CONNECTED_LOCAL_ONLY;
          finalDataState = "collected_local";
        }

        // Store per-scope results in state
        ingestScopeResults = scopeResults?.map((r) => ({
          scope: r.scope,
          status: r.status,
          syncedAt:
            r.status === "stored" ? new Date().toISOString() : undefined,
          error: r.error,
        }));
      }
    }

    launchProgress.settle();

    if (pendingExitCode !== null && !collectedResult) {
      return pendingExitCode;
    }

    if (!collectedResult) {
      await updateSourceState(resolution.source, {
        connectorInstalled: true,
        sessionPresent: fs.existsSync(profilePath),
        lastRunAt: new Date().toISOString(),
        lastRunOutcome: CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR,
        lastError: "Connector run ended without a result.",
        lastLogPath: runLogPath ?? fetchLogPath ?? null,
      });
      renderer?.fail(`Problem connecting ${displayName}.`);
      renderer?.detail("Connector run ended without a result.");
      emit.event({
        type: "outcome",
        status: CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR,
        source: resolution.source,
        reason: "Connector run ended without a result.",
      });
      return 1;
    }

    await updateSourceState(resolution.source, {
      connectorInstalled: true,
      connectorVersion: fetched.version,
      exportFrequency: fetched.exportFrequency,
      sessionPresent: true,
      lastRunAt: new Date().toISOString(),
      lastCollectedAt: new Date().toISOString(),
      lastRunOutcome: finalStatus,
      dataState: finalDataState,
      lastError: ingestFailureMessage,
      lastResultPath: resultPath,
      lastLogPath: runLogPath ?? fetchLogPath ?? setupLogPath ?? null,
      connectionHealth: pendingExitCode !== null ? undefined : "healthy",
      connectionHealthChangedAt:
        pendingExitCode !== null ? undefined : new Date().toISOString(),
      connectionHealthReason:
        pendingExitCode !== null ? undefined : "collection-complete",
      connectionHealthRetryable: undefined,
      ingestScopes: ingestScopeResults,
      skippedStreams: skippedStreams.length > 0 ? skippedStreams : undefined,
    });

    // Build scope-aware success summary
    const storedCount =
      ingestScopeResults?.filter((r) => r.status === "stored").length ?? 0;
    const failedCount =
      ingestScopeResults?.filter((r) => r.status === "failed").length ?? 0;
    const totalScopes = ingestScopeResults?.length ?? 0;

    let successSummary: string;
    if (
      finalStatus === CliOutcomeStatus.CONNECTED_AND_INGESTED &&
      totalScopes > 0
    ) {
      if (failedCount === 0) {
        successSummary = `Collected your ${displayName} data and synced it to your Personal Server.`;
      } else {
        successSummary = `Collected your ${displayName} data. ${storedCount}/${totalScopes} scopes synced, ${failedCount} failed.`;
      }
    } else if (finalStatus === CliOutcomeStatus.CONNECTED_AND_INGESTED) {
      successSummary = `Collected your ${displayName} data and synced it to your Personal Server.`;
    } else if (finalDataState === "ingest_unavailable") {
      successSummary = `Collected your ${displayName} data. Personal Server sync is pending.`;
    } else if (finalDataState === "ingest_failed") {
      successSummary = `Collected your ${displayName} data, but Personal Server sync failed.`;
    } else {
      successSummary = `Collected your ${displayName} data and saved it locally.`;
    }

    const hasSchedule =
      (await getExistingScheduleInterval().catch(() => null)) !== null;

    // --- Phase 7: Success summary ---
    renderer?.success(`Connected ${displayName}.`);
    renderer?.detail(successSummary);
    for (const skip of skippedStreams) {
      renderer?.detail(
        `Skipped ${skip.stream ?? "part of the run"}: ${skip.message ?? skip.reason ?? "no reason given"}. Earlier data for it was kept.`,
      );
    }

    // Partial sync guidance
    if (failedCount > 0 && storedCount > 0) {
      renderer?.detail(`Retry: vana server sync`);
    } else if (finalDataState === "ingest_unavailable") {
      renderer?.detail(`Pending sync will retry during scheduled collection.`);
      renderer?.detail(`Retry now: vana server sync`);
    } else if (finalDataState === "ingest_failed") {
      if (ingestFailureMessage?.includes("401")) {
        renderer?.detail(
          "Your Personal Server requires authentication. Run `vana login` to authenticate, then `vana server sync`.",
        );
      } else {
        renderer?.detail(`Retry: vana server sync`);
      }
    }

    // Journey-aware next step
    const state = await readCliState();
    const connectedSourceCount = Object.values(state.sources ?? {}).filter(
      (s) => hasCollectedData((s as SourceStatus)?.dataState),
    ).length;

    renderer?.detail("");
    if (connectedSourceCount > 1) {
      renderer?.next("vana sources");
    } else {
      renderer?.next(`vana data show ${source}`);
    }

    if (!hasSchedule) {
      renderer?.detail(
        "Keep this fresh automatically — run `vana schedule add` to collect on a schedule.",
      );
    }

    // Suggest skills if not yet installed
    const installedSkills = await readInstalledSkills();
    if (installedSkills.length === 0) {
      renderer?.detail(
        "Your coding agent can use this data — run `vana skills` to see how.",
      );
    }

    renderer?.bell();

    // Offer skill install on first successful connect (ask once)
    if (
      !state.config?.skillsPromptCompleted &&
      !options.json &&
      !options.noInput &&
      process.stdin.isTTY
    ) {
      await maybePromptSkillInstall(emit);
    }

    // Emit for --json consumers (unchanged)
    emit.event({
      type: "outcome",
      status: finalStatus,
      source: resolution.source,
      resultPath,
    });
    if (pendingExitCode !== null) {
      return pendingExitCode;
    }
    return 0;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "__vana_prompt_cancelled__"
    ) {
      await updateSourceState(source, {
        lastRunAt: new Date().toISOString(),
        lastRunOutcome: CliOutcomeStatus.NEEDS_INPUT,
        lastError: "Cancelled before input was completed.",
        lastLogPath: runLogPath ?? null,
      });
      renderer?.fail("Cancelled.");
      emit.event({
        type: "outcome",
        status: CliOutcomeStatus.NEEDS_INPUT,
        source,
        reason: "prompt_cancelled",
      });
      return 1;
    }
    const message =
      error instanceof Error ? error.message : "Unexpected error.";
    renderer?.fail(`Problem connecting ${displayName}.`);
    renderer?.detail(message);
    renderer?.detail(`Retry: vana connect ${source}`);
    emit.event({
      type: "outcome",
      status: CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR,
      source,
      reason: message,
    });
    return 1;
  } finally {
    renderer?.cleanup();
  }
}

async function runConnectEntry(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const sources = await loadRegistrySources();
  const state = await readCliState();
  const sourceMetadata = createSourceMetadataMap(sources);
  const statuses = await gatherSourceStatuses(state.sources, sourceMetadata);
  const statusMap = new Map(statuses.map((source) => [source.source, source]));
  const enrichedSources = sources.map((source) => {
    const status = statusMap.get(source.id);
    return {
      ...source,
      dataState: status?.dataState,
      lastRunOutcome: status?.lastRunOutcome ?? null,
      sessionPresent: status?.sessionPresent ?? false,
    };
  });
  const suggestedSource =
    enrichedSources.find(
      (source) =>
        source.authMode !== "legacy" && !hasCollectedData(source.dataState),
    ) ??
    enrichedSources.find((source) => source.authMode !== "legacy") ??
    enrichedSources[0];
  const missingSourceMessage =
    formatMissingConnectSourceMessage(suggestedSource);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        error: "source_required",
        message: missingSourceMessage,
        suggestedSource: suggestedSource
          ? {
              id: suggestedSource.id,
              name: suggestedSource.name,
              authMode: suggestedSource.authMode,
            }
          : null,
      })}\n`,
    );
    return CliExitCode.USAGE;
  }

  if (options.noInput) {
    emit.info(missingSourceMessage);
    return CliExitCode.USAGE;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    emit.info(missingSourceMessage);
    return CliExitCode.USAGE;
  }

  if (enrichedSources.length === 0) {
    emit.info("No sources are available right now.");
    emit.info("Run `vana sources` to verify the local connector registry.");
    return 1;
  }

  // Build inquirer-compatible choices from enriched sources
  const choices = enrichedSources.map((item) => {
    const connected = hasCollectedData(item.dataState);
    const hint = connected
      ? "connected"
      : item.authMode === "legacy"
        ? "browser login"
        : undefined;
    return {
      value: item.id,
      name: item.name,
      description: hint,
    };
  });

  try {
    const source = await searchSelect({
      message: "Choose a source to connect.",
      choices,
      ...vanaPromptTheme,
    });

    return runConnect(source as string, options);
  } catch (error) {
    if (isPromptCancelled(error)) {
      emit.info("Cancelled.");
      return 1;
    }
    throw error;
  }
}

/**
 * The id commands take, shown next to a name that does not spell it:
 * "Claude Code" is run as `claude-code-local`.
 */
function sourceIdBadge(source: {
  id: string;
  name: string;
}): Array<{ text: string; tone?: RenderTone }> {
  return source.name.toLowerCase() === source.id
    ? []
    : [{ text: `(${source.id})`, tone: "muted" }];
}

async function runList(options: GlobalOptions): Promise<number> {
  const result = await querySources();
  const { sources: enrichedSources, recommendedSource } = result;

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const emit = createEmitter(options);
  emit.title("Available sources");
  emit.blank();

  if (enrichedSources.length === 0) {
    emit.info("No sources are available right now.");
  } else {
    const connectedSources = enrichedSources.filter((source) =>
      hasCollectedData(source.dataState),
    );
    const unconnectedSources = enrichedSources.filter(
      (source) => !hasCollectedData(source.dataState),
    );

    // Connected sources are always shown expanded
    if (connectedSources.length > 0) {
      emit.section("Connected");
      for (const source of connectedSources) {
        const badges: Array<{ text: string; tone?: RenderTone }> = [];
        if (source.dataState === "ingested_personal_server") {
          badges.push({ text: "synced", tone: "success" });
        } else if (source.dataState === "ingest_failed") {
          badges.push({ text: "sync failed", tone: "warning" });
        } else {
          badges.push({ text: "local", tone: "muted" });
        }
        if (source.runtime === "pdpp") {
          badges.push({ text: "collection profile", tone: "muted" });
        }
        if (source.origin === "local") {
          badges.push({ text: "local", tone: "warning" });
        }
        emit.sourceTitle(source.name, [...sourceIdBadge(source), ...badges]);
        emit.detail(
          `Inspect with ${emit.code(`vana data show ${source.id}`)}.`,
        );
      }
      emit.blank();
      emit.section("Available");
    }

    for (const source of unconnectedSources) {
      const badges: Array<{ text: string; tone?: RenderTone }> = [];
      if (
        recommendedSource?.id === source.id &&
        recommendedSource.authMode !== "legacy"
      ) {
        badges.push({ text: "recommended", tone: "accent" });
      }
      if (source.runtime === "pdpp") {
        badges.push({ text: "collection profile", tone: "muted" });
      }
      if (source.origin === "local") {
        badges.push({ text: "local", tone: "warning" });
      }
      emit.sourceTitle(source.name, [...sourceIdBadge(source), ...badges]);
      if (source.description) {
        emit.detail(cleanDescription(source.description));
      }
    }

    if (recommendedSource) {
      emit.blank();
      emit.next(`vana connect ${recommendedSource.id}`);
    }
  }
  return 0;
}

async function runStatus(options: GlobalOptions): Promise<number> {
  const { status, nextSteps } = await queryStatus();
  const state = await readCliState();

  // Build per-source health map from stored state
  const sourceHealthMap: Record<
    string,
    {
      connectionHealth?: string;
      connectionHealthChangedAt?: string;
      connectionHealthReason?: string;
      connectionHealthRetryable?: boolean;
      lastCollectedAt?: string;
      lastLogPath?: string | null;
      lastError?: string | null;
    }
  > = {};
  for (const [sourceId, stored] of Object.entries(state.sources)) {
    if (stored) {
      sourceHealthMap[sourceId] = {
        connectionHealth: stored.connectionHealth,
        connectionHealthChangedAt: stored.connectionHealthChangedAt,
        connectionHealthReason: stored.connectionHealthReason,
        connectionHealthRetryable: stored.connectionHealthRetryable,
        lastCollectedAt: stored.lastCollectedAt,
        lastLogPath: stored.lastLogPath,
        lastError: stored.lastError,
      };
    }
  }

  // The server answering here may be another account's, still running after
  // a login switch: it is listed as such, never as this account's.
  const authCreds = loadCredentials();
  const other = foreignServer(
    {
      state: status.personalServer,
      url: status.personalServerUrl ?? null,
      owner: status.personalServerOwner ?? null,
    },
    authCreds,
  );
  const ownRunning = status.personalServer === "available" && !other;
  const ownDir =
    authCreds && !isExpired(authCreds)
      ? ownCliServerDir(
          resolveNetwork(options.network).name,
          authCreds.account.address,
        )
      : null;

  if (options.json) {
    const jsonAuthCreds = authCreds;
    const compactJson = {
      runtime: status.runtime,
      personalServer: ownRunning ? status.personalServer : "unavailable",
      personalServerUrl: ownRunning ? status.personalServerUrl : null,
      ownPersonalServer: {
        running: ownRunning,
        url: ownRunning ? (status.personalServerUrl ?? null) : null,
        dataDir: ownDir?.dir ?? null,
      },
      otherPersonalServer: other
        ? { url: other.url, owner: other.owner, notThisAccount: true }
        : null,
      pendingSyncCount: status.pendingSyncCount ?? 0,
      auth: jsonAuthCreds
        ? {
            authenticated: !isExpired(jsonAuthCreds),
            address: jsonAuthCreds.account.address,
            expires_at: jsonAuthCreds.account.expires_at,
          }
        : { authenticated: false },
      sources: {
        connected: status.summary?.connectedCount ?? 0,
        needsAttention: status.summary?.needsAttentionCount ?? 0,
      },
      sourceHealth: sourceHealthMap,
      lastScheduledRun: state.lastScheduledRun ?? null,
      next: other ? "vana server start" : (nextSteps[0] ?? null),
    };
    process.stdout.write(`${JSON.stringify(compactJson)}\n`);
    return 0;
  }

  const emit = createEmitter(options);
  const registrySources = await loadRegistrySources();
  const sourceLabels = createSourceLabelMap(registrySources);
  emit.title("Vana Connect");
  emit.blank();
  emit.keyValue("Runtime", status.runtime, toneForRuntime(status.runtime));
  if (ownRunning) {
    emit.keyValue(
      "Personal Server",
      status.personalServerUrl ?? "connected",
      "success",
    );
  } else if (other || ownDir) {
    emit.keyValue("Personal Server", "not running", "warning");
  } else {
    emit.keyValue("Personal Server", "not connected", "warning");
  }

  // Auth state
  if (authCreds && !isExpired(authCreds)) {
    emit.keyValue("Account", authCreds.account.address, "success");
    emit.keyValue(
      "Auth",
      `Authenticated (expires in ${formatExpiresIn(authCreds.account.expires_at)})`,
      "success",
    );
  } else {
    emit.keyValue("Account", "Not logged in", "muted");
    emit.keyValue("Auth", "Run `vana login` to authenticate", "muted");
  }

  if (other) {
    emit.keyValue(
      "Also running",
      `${other.url} for ${other.owner} (not this account)`,
      "muted",
    );
  }
  if (!ownRunning && (other || ownDir)) {
    emit.detail(ownServerDownLine(Boolean(ownDir)));
  }

  const trackedSources = status.sources.filter(shouldDisplaySourceInStatus);
  const attentionSources = trackedSources
    .filter(isSourceAttention)
    .sort(compareAttentionPriority);
  const notCollectedSources = trackedSources
    .filter(isSourceNotCollected)
    .sort(compareSourceStatusOrder);
  const healthySources = trackedSources
    .filter(
      (source) => !isSourceAttention(source) && !isSourceNotCollected(source),
    )
    .sort(compareSourceStatusOrder);
  const sourceParts = [
    healthySources.length > 0
      ? `${healthySources.length} healthy`
      : trackedSources.length > 0
        ? "none healthy"
        : "none connected",
    ...(attentionSources.length > 0
      ? [
          `${attentionSources.length} need${attentionSources.length === 1 ? "s" : ""} attention`,
        ]
      : []),
    ...(notCollectedSources.length > 0
      ? [`${notCollectedSources.length} not collected yet`]
      : []),
  ];
  emit.keyValue(
    "Sources",
    sourceParts.join(", "),
    attentionSources.length > 0 && healthySources.length > 0
      ? "warning"
      : healthySources.length > 0
        ? "success"
        : "muted",
  );
  if ((status.pendingSyncCount ?? 0) > 0) {
    emit.keyValue(
      "Pending sync",
      `${status.pendingSyncCount} dataset(s)`,
      "warning",
    );
  }
  if (state.lastScheduledRun) {
    const lastRun = describeScheduledRun(
      state.lastScheduledRun,
      formatTimestamp,
      formatDisplayPath,
    );
    emit.keyValue(
      "Last scheduled collection",
      lastRun.text,
      lastRun.failed ? "warning" : "muted",
    );
  }

  if (attentionSources.length > 0) {
    emit.blank();
    emit.section(formatCountLabel("Needs attention", attentionSources.length));
    for (const source of attentionSources) {
      emitHumanStatusSource(emit, source, sourceLabels);
    }
  }

  if (healthySources.length > 0) {
    emit.blank();
    emit.section(formatCountLabel("Healthy", healthySources.length));
    for (const source of healthySources) {
      emitHumanStatusSource(emit, source, sourceLabels);
    }
  }

  if (notCollectedSources.length > 0) {
    emit.blank();
    emit.section(
      formatCountLabel("Not collected yet", notCollectedSources.length),
    );
    for (const source of notCollectedSources) {
      emitHumanStatusSource(emit, source, sourceLabels);
    }
  }

  if (nextSteps.length > 0) {
    emit.blank();
    const command = extractCommand(nextSteps[0]);
    if (command) {
      emit.next(command);
    } else {
      emit.detail(`Next: ${nextSteps[0]}`);
    }
  }
  return 0;
}

function shouldDisplaySourceInStatus(source: SourceStatus): boolean {
  return (
    source.installed ||
    Boolean(source.lastRunOutcome) ||
    source.dataState !== "none" ||
    Boolean(source.connectionHealth)
  );
}

function emitHumanStatusSource(
  emit: ReturnType<typeof createEmitter>,
  source: SourceStatus,
  sourceLabels: SourceLabelMap,
): void {
  const displayName = displaySource(source.source, sourceLabels);
  const presentation = getHumanStatusPresentation(source);
  const staleTag = source.isOverdue ? ` ${emit.badge("stale", "warning")}` : "";
  const collectedAgo = source.lastCollectedAt
    ? `collected ${formatRelativeTime(source.lastCollectedAt)}`
    : "";

  emit.keyValue(
    `  ${displayName}`,
    `${presentation.label}${staleTag}${collectedAgo ? `     ${collectedAgo}` : ""}`,
    presentation.tone,
  );

  const detail = formatHumanStatusDetail(source);
  if (detail) {
    emit.detail(`  \u21b3 ${detail}`);
  }
}

function getHumanStatusPresentation(source: SourceStatus): {
  label: string;
  tone: RenderTone;
} {
  if (source.dataState === "ingest_failed") {
    return { label: "sync failed", tone: "warning" };
  }
  if (source.dataState === "ingest_unavailable") {
    return { label: "pending sync", tone: "warning" };
  }
  if (source.connectionHealth === "needs_reauth") {
    return { label: "needs login", tone: "warning" };
  }
  if (source.connectionHealth === "error") {
    return { label: "error", tone: "error" };
  }

  const presentation = getSourceStatusPresentation(source);
  if (presentation.label === "needs input") {
    return { label: "needs login", tone: presentation.tone };
  }

  return presentation;
}

function formatHumanStatusDetail(source: SourceStatus): string | null {
  if (source.dataState === "ingest_failed") {
    return formatSyncFailureSummary(source);
  }
  if (source.dataState === "ingest_unavailable") {
    return "Personal Server unavailable. Pending sync will retry during scheduled collection. Run `vana server sync`.";
  }
  if (
    source.connectionHealth === "needs_reauth" ||
    source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT
  ) {
    return `Authentication required. Run \`vana connect ${source.source}\`.`;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    return `Manual auth step required. Run \`vana connect ${source.source}\`.`;
  }
  if (source.connectionHealth === "error") {
    const message = formatHealthMessage(source.connectionHealthReason);
    return `${message ?? "Collection failed."} Run \`vana connect ${source.source}\`.`;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    return `${humanizeIssue(source.lastError ?? "Collection failed")}. Run \`vana connect ${source.source}\`.`;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
    return "No connector available. Run `vana sources`.";
  }
  if (
    source.dataState === "ingested_personal_server" &&
    source.ingestScopes?.some((scope) => scope.status === "failed")
  ) {
    return formatSyncFailureSummary(source);
  }
  if (!source.lastRunOutcome && !hasCollectedData(source.dataState)) {
    return `Run \`vana connect ${source.source}\` to collect data.`;
  }
  if (source.skippedStreams && source.skippedStreams.length > 0) {
    const streams = source.skippedStreams
      .map((skip) => skip.stream ?? "the whole run")
      .join(", ");
    return `Skipped last run: ${streams}. Earlier data for them was kept. Details: \`vana logs ${source.source}\`.`;
  }
  return null;
}

function formatSyncFailureSummary(source: SourceStatus): string {
  const failedScopes =
    source.ingestScopes?.filter((scope) => scope.status === "failed") ?? [];
  if (failedScopes.length === 0) {
    return `Personal Server sync failed. Run \`vana connect ${source.source}\`.`;
  }

  const groupedFailures = new Map<string, number>();
  for (const failedScope of failedScopes) {
    const summary = humanizeIssue(failedScope.error ?? "Sync failed");
    groupedFailures.set(summary, (groupedFailures.get(summary) ?? 0) + 1);
  }

  // The collected data is fine; the server refused the CLI's session, which
  // only a new login fixes.
  const remedy = isPersonalServerAuthFailure(source)
    ? "Run `vana login`, then `vana server sync`."
    : `Run \`vana connect ${source.source}\`.`;
  const entries = Array.from(groupedFailures.entries());
  if (entries.length === 1) {
    const [summary, count] = entries[0];
    return `${summary}${count > 1 ? ` for ${count} scopes` : ""}. ${remedy}`;
  }

  const summaryParts = entries.map(([summary, count]) =>
    count > 1 ? `${summary} (${count})` : summary,
  );
  return `${failedScopes.length} scopes failed to sync: ${summaryParts.join("; ")}. ${remedy}`;
}

/** A Personal Server sync error that means the server refused our session. */
function isPersonalServerAuthError(error: string | undefined): boolean {
  if (!error) return false;
  return (
    /^HTTP\s+401\b/.test(error) ||
    humanizeIssue(error) === "Authentication required"
  );
}

/** True when every failed scope of a source failed on Personal Server auth. */
function isPersonalServerAuthFailure(source: SourceStatus): boolean {
  const failedScopes =
    source.ingestScopes?.filter((scope) => scope.status === "failed") ?? [];
  return (
    failedScopes.length > 0 &&
    failedScopes.every((scope) => isPersonalServerAuthError(scope.error))
  );
}

async function runDoctor(options: GlobalOptions): Promise<number> {
  const basePayload = await queryDoctor();
  // Builder-side protocol network (owner-side server config is separate and
  // reported by its own checks). Additive field; the rest of the payload
  // still matches CliDoctor exactly. A bad VANA_NETWORK/VANA_ENV combination
  // is a usage problem, not a crash: exit 2 with a structured message.
  let network: ReturnType<typeof resolveNetwork>;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ error: "bad_usage", message: error.message })}\n`,
        );
      } else {
        process.stderr.write(`${error.message}\n`);
      }
      return CliExitCode.USAGE;
    }
    throw error;
  }
  const payload = {
    ...basePayload,
    network: {
      name: network.name,
      env: network.env,
      chainId: network.chainId,
      gatewayUrl: network.gatewayUrl,
      source: options.network
        ? "flag"
        : process.env.VANA_NETWORK
          ? "env"
          : "default",
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }

  const sourceLabels = createSourceLabelMap(await loadRegistrySources());
  const { recentSources } = payload;
  const attentionSources = recentSources.filter(
    (source) => rankSourceStatus(source) <= 4,
  );

  const emit = createEmitter(options);
  emit.title("Vana Connect doctor");
  emit.section("Summary");
  emit.keyValue("CLI", payload.cliVersion, "muted");
  emit.keyValue("Channel", payload.channel, "muted");
  emit.keyValue(
    "Install",
    formatInstallMethodLabel(payload.installMethod),
    "muted",
  );
  emit.keyValue("Runtime", payload.runtime, toneForRuntime(payload.runtime));
  emit.keyValue(
    "Personal Server",
    payload.personalServer,
    payload.personalServer === "available" ? "success" : "warning",
  );
  emit.keyValue(
    "Network",
    `${payload.network.name} (chain ${payload.network.chainId}, ${payload.network.source})`,
    "muted",
  );
  emit.keyValue(
    "Tracked sources",
    String(payload.summary.trackedSourceCount),
    "muted",
  );
  emit.keyValue(
    "Attention",
    String(payload.summary.attentionCount),
    payload.summary.attentionCount > 0 ? "warning" : "muted",
  );
  emit.keyValue(
    "Connected",
    String(payload.summary.connectedCount),
    payload.summary.connectedCount > 0 ? "success" : "muted",
  );
  emit.blank();
  emit.section("Checks");
  for (const check of payload.checks) {
    const tone: RenderTone =
      check.status === "ok"
        ? "success"
        : check.status === "warn"
          ? "warning"
          : "error";
    emit.keyValue(check.label, check.detail, tone);
  }
  if (recentSources.length > 0) {
    emit.blank();
    emit.section(
      attentionSources.length > 0
        ? "Needs attention"
        : "Recent source activity",
    );
    for (const source of attentionSources.length > 0
      ? attentionSources
      : recentSources) {
      const status = getSourceStatusPresentation(source);
      const badges: Array<{ text: string; tone?: RenderTone }> = [];
      badges.push({ text: status.label, tone: status.tone });
      emit.sourceTitle(displaySource(source.source, sourceLabels), badges);
      const details = formatSourceStatusDetails(source);
      for (const detail of details) {
        if (detail.kind === "row") {
          emit.keyValue(detail.label, detail.value, detail.tone ?? "muted");
        } else {
          emit.detail(humanizeIssue(detail.message));
        }
      }
    }
  }
  emit.blank();
  emit.section("Paths");
  emit.keyValue(
    "Executable",
    formatDisplayPath(payload.paths.executable),
    "muted",
  );
  if (payload.paths.appRoot) {
    emit.keyValue(
      "App root",
      formatDisplayPath(payload.paths.appRoot),
      "muted",
    );
  }
  emit.keyValue(
    "Data home",
    formatDisplayPath(payload.paths.dataHome),
    "muted",
  );
  emit.keyValue(
    "State file",
    formatDisplayPath(payload.paths.stateFile),
    "muted",
  );
  emit.keyValue(
    "Connector cache",
    formatDisplayPath(payload.paths.connectorCache),
    "muted",
  );
  emit.keyValue(
    "Browser profiles",
    formatDisplayPath(payload.paths.browserProfiles),
    "muted",
  );
  emit.keyValue("Logs", formatDisplayPath(payload.paths.logs), "muted");
  emit.blank();
  emit.section("Lifecycle");
  emit.keyValue("Upgrade", payload.lifecycle.upgrade, "muted");
  emit.keyValue("Uninstall", payload.lifecycle.uninstall, "muted");
  if (payload.nextSteps.length > 0) {
    emit.blank();
    const command = extractCommand(payload.nextSteps[0]);
    if (command) {
      emit.next(command);
    } else {
      emit.detail(`Next: ${payload.nextSteps[0]}`);
    }
  }

  return 0;
}

/** Which network a server serves, from the gateway it reports. */
function networkOfGateway(gatewayUrl: unknown): VanaNetworkName | null {
  if (typeof gatewayUrl !== "string") return null;
  return /dp-rpc\.vana\.org/.test(gatewayUrl) ? "mainnet" : "moksha";
}

/**
 * The server answering here when it belongs to another account than the one
 * signed in now: it is never presented as this account's server.
 */
function foreignServer(
  server: { state: string; url: string | null; owner: string | null },
  credentials: VanaCredentials | null,
): { url: string; owner: string; account: string } | null {
  if (server.state !== "available" || !server.url) return null;
  if (!credentials || isExpired(credentials)) return null;
  const mismatch = personalServerOwnerMismatch(
    server.owner,
    credentials.account.address,
  );
  return mismatch ? { url: server.url, ...mismatch } : null;
}

/** This account's own `vana server start` data dir, running or not. */
function ownCliServerDir(
  network: VanaNetworkName,
  account: string | null | undefined,
): CliServerDir | null {
  if (!account || account === "env") return null;
  try {
    return (
      listServerDataDirs(network).find((server) =>
        sameAccountAddress(server.owner, account),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** What to say when this account's own server is not the one running. */
function ownServerDownLine(hasOwnServer: boolean): string {
  return hasOwnServer
    ? "Your Personal Server is not running. Start it with `vana server start`."
    : "No Personal Server of yours is running. Start one with `vana server start`.";
}

/**
 * Where the running server keeps its data on this machine, when known: a
 * server vana started is the one whose data dir holds a live lock and the
 * key the server answers with, whoever is signed in now.
 */
export function localDataDir(
  target: PersonalServerTarget,
  network: VanaNetworkName | null,
  cliServers: CliServerDir[] = network ? runningCliServers(network) : [],
): { path: string; runBy: "cli" | "desktop"; owner: string | null } | null {
  if (!target.url || !network) return null;
  const identity = target.health?.identity ?? null;
  const owner = target.health?.owner ?? null;
  // A server that does not report its key: the one auth.json says vana
  // started at this URL, when that tells which one.
  const saved = readStoredAuthFile();
  const startedHere =
    saved?.personalServer?.started_by === "vana-server-start" &&
    urlsMatch(saved.personalServer.url, target.url);
  const cli =
    cliServers.find((server) =>
      identity
        ? sameAccountAddress(server.identity, identity)
        : sameAccountAddress(server.owner, owner),
    ) ??
    (!identity && startedHere
      ? (cliServers.find((server) =>
          sameAccountAddress(server.owner, saved?.address),
        ) ?? (cliServers.length === 1 ? cliServers[0] : undefined))
      : undefined);
  if (cli) return { path: cli.dir, runBy: "cli", owner: cli.owner ?? owner };
  const desktop = path.join(getVanaHome(), "desktop", "personal-server");
  const perNetwork = path.join(desktop, network);
  if (fs.existsSync(perNetwork)) {
    return { path: perNetwork, runBy: "desktop", owner };
  }
  if (fs.existsSync(desktop)) return { path: desktop, runBy: "desktop", owner };
  return null;
}

async function runServerStatus(
  options: GlobalOptions,
  statusOptions: { all?: boolean } = {},
): Promise<number> {
  const emit = createEmitter(options);
  const target = await detectPersonalServerTarget();
  const credentials = loadCredentials();
  const account = credentials?.account.address;
  // The same check `vana status` makes: the server answering here may be
  // another account's, still running after a login switch. Then nothing
  // below is about it: its URLs are not this account's to hand out.
  const other = foreignServer(
    {
      state: target.state,
      url: target.url,
      owner: target.health?.owner ?? null,
    },
    credentials,
  );
  const own: PersonalServerTarget = other
    ? { state: "unavailable", url: null, source: null, health: null }
    : target;
  const owner =
    own.health?.owner ?? (account && account !== "env" ? account : null);
  // Every registration this owner has, checked from outside: the live one is
  // where apps actually reach the data; the rest are old server identities.
  const registrations = owner
    ? await checkRegisteredServers(await lookupRegisteredServers(owner), owner)
    : [];
  const localIdentity = own.health?.identity?.toLowerCase();
  const live =
    registrations.find(
      (server) =>
        server.reachable &&
        server.serverAddress.toLowerCase() === localIdentity,
    ) ??
    registrations.find((server) => server.reachable) ??
    null;
  const stale = registrations.filter((server) => !server.reachable);
  const network =
    networkOfGateway(target.health?.gatewayUrl) ??
    live?.network ??
    (own.url ? null : resolveNetwork(options.network).name);
  const cliServers = network ? runningCliServers(network) : [];
  // This account's own data dir, also while its server is down.
  const ownDir =
    !own.url && network && credentials && !isExpired(credentials)
      ? ownCliServerDir(network, account)
      : null;
  const dataDir =
    localDataDir(own, network, cliServers) ??
    (ownDir
      ? { path: ownDir.dir, runBy: "cli" as const, owner: ownDir.owner }
      : null);
  // Servers vana runs here for other accounts, which this status is not about.
  const otherCliServers = cliServers.filter(
    (server) => server.dir !== dataDir?.path,
  );
  const otherIdentity = other ? (target.health?.identity ?? null) : null;
  const isOtherServer = (server: CliServerDir) =>
    Boolean(
      other &&
      (otherIdentity
        ? sameAccountAddress(server.identity, otherIdentity)
        : sameAccountAddress(server.owner, other.owner)),
    );
  const state = await readCliState();

  // Count scopes from state
  let totalScopeCount = 0;
  for (const stored of Object.values(state.sources)) {
    if (stored?.ingestScopes) {
      totalScopeCount += stored.ingestScopes.filter(
        (s) => s.status === "stored",
      ).length;
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        state: own.state,
        url: own.url,
        source: own.source,
        owner,
        running: own.state === "available",
        publicUrl: live?.url ?? null,
        publicNetwork: live?.network ?? null,
        dataDir: dataDir?.path ?? null,
        runBy: dataDir?.runBy ?? null,
        otherServer: other
          ? {
              url: other.url,
              owner: other.owner,
              source: target.source,
              identity: otherIdentity,
              pid: cliServers.find(isOtherServer)?.pid ?? null,
              health: target.health,
            }
          : null,
        otherLocalServers: otherCliServers.map((server) => ({
          owner: server.owner,
          pid: server.pid,
          dataDir: server.dir,
        })),
        registeredServers: registrations,
        health: own.health,
        scopeCount: totalScopeCount,
        notThisAccount: other !== null,
      })}\n`,
    );
    return 0;
  }

  emit.title("Personal Server");
  emit.blank();

  if (live) {
    emit.keyValue(
      "Public URL",
      `${live.url} (${live.network}, reachable)`,
      "success",
    );
  } else if (own.state === "available") {
    emit.keyValue("Public URL", "none: apps cannot reach your data", "warning");
  } else {
    emit.keyValue(
      "Public URL",
      "none: no server of yours is answering",
      "warning",
    );
  }

  if (live) {
    // Paste into claude.ai (Settings, Connectors) or any remote MCP client;
    // the owner approves it once on this machine.
    emit.keyValue("MCP URL", `${live.url.replace(/\/+$/, "")}/mcp`, "muted");
  }

  if (own.url) {
    const runBy =
      dataDir?.runBy === "cli"
        ? `vana server start${dataDir.owner ? ` for ${formatAddress(dataDir.owner)}` : ""}`
        : dataDir?.runBy === "desktop"
          ? "Vana Desktop"
          : own.source === "scan"
            ? "found running"
            : own.source === "env"
              ? "from VANA_PERSONAL_SERVER_URL"
              : "saved";
    emit.keyValue("Local URL", `${own.url} (${runBy})`, "muted");
  } else {
    emit.keyValue(
      "Local URL",
      other
        ? "your server is not running on this machine"
        : "no server running on this machine",
      other ? "warning" : "muted",
    );
  }
  if (dataDir) {
    emit.keyValue("Data on disk", formatDisplayPath(dataDir.path), "muted");
  }
  if (other) {
    const pid = cliServers.find(isOtherServer)?.pid;
    emit.keyValue(
      "Also running",
      `${other.url} for ${formatAddress(other.owner)}${pid ? ` (pid ${pid})` : ""}, not this account`,
      "muted",
    );
  }
  for (const server of otherCliServers) {
    if (isOtherServer(server)) continue;
    emit.keyValue(
      "Also running",
      `vana server start for ${server.owner ? formatAddress(server.owner) : "another account"} (pid ${server.pid})`,
      "muted",
    );
  }
  if (live) {
    emit.keyValue(
      "Backup",
      "encrypted in Vana storage, follows your account",
      "muted",
    );
  }

  if (own.health) {
    emit.keyValue("Version", own.health.version, "muted");
    emit.keyValue("Uptime", formatUptime(own.health.uptime), "muted");
  }
  if (owner) {
    emit.keyValue(other ? "Signed in as" : "Owner", owner, "muted");
  }
  if (totalScopeCount > 0) {
    emit.keyValue("Scopes", `${totalScopeCount} stored`, "muted");
  }

  // Old registrations are noise for the person reading this; --all lists
  // them, and --json always carries them.
  if (statusOptions.all) {
    for (const server of stale) {
      emit.keyValue(
        "Old server",
        `${server.url} (${server.network}, not answering)`,
        "muted",
      );
    }
  }

  if (own.state !== "available") {
    emit.blank();
    if (other || ownDir) emit.detail(ownServerDownLine(Boolean(ownDir)));
    emit.next("vana server start");
  }

  emit.blank();
  emit.detail(
    `More: ${emit.code("vana server sync")} | ${emit.code("vana server data")} | ${emit.code("vana server --help")}`,
  );

  return 0;
}

async function runServerSetUrl(
  url: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);

  try {
    new URL(url);
  } catch {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: "Invalid URL" })}\n`,
      );
    } else {
      emit.info(`Invalid URL: ${url}`);
    }
    return 1;
  }

  await updateCliConfig({ personalServerUrl: url });

  const target = await detectPersonalServerTarget();

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        url,
        reachable: target.state === "available",
        health: target.health,
      })}\n`,
    );
    return 0;
  }

  emit.info(`Saved Personal Server URL: ${url}`);
  if (target.state === "available") {
    emit.info(
      `Server is reachable (${target.health?.version ?? "unknown version"}).`,
    );
  } else {
    emit.info("Server is not reachable yet. It will be used when available.");
  }

  return 0;
}

async function runServerClearUrl(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const config = await readCliConfig();

  if (!config.personalServerUrl) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, cleared: false })}\n`);
    } else {
      const target = await detectPersonalServerTarget();
      if (target.source === "scan" && target.url) {
        emit.info(
          "No saved URL to clear. Current connection is auto-detected on localhost.",
        );
        emit.info(
          `Run ${emit.code("vana server set-url <url>")} to save a specific URL.`,
        );
      } else {
        emit.info("No saved Personal Server URL to clear.");
      }
    }
    return 0;
  }

  await updateCliConfig({ personalServerUrl: undefined });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, cleared: true })}\n`);
  } else {
    emit.info("Cleared saved Personal Server URL.");
  }

  return 0;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

async function runSetup(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const runtime = new ManagedPlaywrightRuntime();
  const registrySources = await loadRegistrySources();
  const suggestedSource =
    registrySources.find((source) => source.authMode !== "legacy") ??
    registrySources[0];

  emit.title("Vana Connect setup");
  emit.section("Runtime");

  if (runtime.state === "installed") {
    emit.info("The local runtime is already installed.");
    if (runtime.runtimePath) {
      emit.keyValue("Browser", formatDisplayPath(runtime.runtimePath), "muted");
    }
    emit.blank();
    if (suggestedSource) {
      emit.next(`vana connect ${suggestedSource.id}`);
    } else {
      emit.next("vana connect");
    }
    emit.event({ type: "setup-check", runtime: runtime.state });
    return 0;
  }

  try {
    const result = await runtime.ensureInstalled(Boolean(options.yes));
    emit.success("Runtime ready.");
    if (result.logPath) {
      emit.detail(`Setup log: ${formatDisplayPath(result.logPath)}`);
    }
    emit.blank();
    if (suggestedSource) {
      emit.next(`vana connect ${suggestedSource.id}`);
    } else {
      emit.next("vana connect");
    }
    emit.event({
      type: "setup-complete",
      runtime: result.runtime,
      logPath: result.logPath,
    });
    return 0;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Vana Connect could not finish installing the local runtime.";
    emit.info(message);
    emit.event({
      type: "outcome",
      status: CliOutcomeStatus.RUNTIME_ERROR,
      reason: message,
    });
    return 1;
  }
}

async function runDataList(options: GlobalOptions): Promise<number> {
  const result = await queryDataList();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const { datasets: datasetRecords } = result;
  const registrySources = await loadRegistrySources();
  const emit = createEmitter(options);
  if (datasetRecords.length === 0) {
    const suggestedSource =
      registrySources.find((source) => source.authMode !== "legacy") ??
      registrySources[0];
    emit.title("Collected data");
    emit.blank();
    emit.info("  No datasets yet.");
    emit.blank();
    if (suggestedSource) {
      emit.next(`vana connect ${suggestedSource.id}`);
    } else {
      emit.next("vana connect");
    }
    return 0;
  }

  emit.title(
    datasetRecords.length > 0
      ? `Collected data (${datasetRecords.length})`
      : "Collected data",
  );
  emit.blank();
  emit.info(
    joinOverviewParts([
      `${datasetRecords.length} dataset${datasetRecords.length === 1 ? "" : "s"}`,
      `${
        datasetRecords.filter(
          (dataset) => dataset.dataState !== "ingested_personal_server",
        ).length
      } local only`,
      `${
        datasetRecords.filter(
          (dataset) => dataset.dataState === "ingested_personal_server",
        ).length
      } synced`,
      datasetRecords.some((dataset) => dataset.dataState === "ingest_failed")
        ? `${
            datasetRecords.filter(
              (dataset) => dataset.dataState === "ingest_failed",
            ).length
          } sync failed`
        : "",
    ]),
  );
  emit.blank();
  datasetRecords.forEach((dataset, index) => {
    if (index > 0) {
      emit.blank();
    }
    const badges =
      dataset.dataState === "ingested_personal_server"
        ? [{ text: "synced", tone: "success" as const }]
        : dataset.dataState === "ingest_failed"
          ? [{ text: "sync failed", tone: "warning" as const }]
          : [{ text: "local", tone: "muted" as const }];
    emit.sourceTitle(dataset.name ?? displaySource(dataset.source), badges);
    if (dataset.summary) {
      for (const line of dataset.summary.lines) {
        emit.detail(line);
      }
    }
    if (dataset.dataState === "ingested_personal_server") {
      emit.keyValue("State", "Synced to Personal Server", "success");
    } else if (dataset.dataState === "ingest_failed") {
      emit.keyValue("State", "Saved locally, sync failed", "warning");
    } else {
      emit.keyValue("State", "Saved locally", "muted");
    }
    if (dataset.lastRunAt) {
      emit.keyValue("Updated", formatTimestamp(dataset.lastRunAt), "muted");
    }
    if (dataset.path) {
      emit.keyValue("Path", formatDisplayPath(dataset.path), "muted");
    }
  });
  emit.blank();
  if (datasetRecords.length > 0) {
    emit.next(`vana data show ${datasetRecords[0].source}`);
  }
  return 0;
}

async function runDataShow(
  source: string,
  options: GlobalOptions,
): Promise<number> {
  const result = await queryDataShow(source);

  if (!result.ok) {
    if (result.error === "unknown_source") {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            error: result.error,
            source: result.source,
            message: result.message,
            suggestedSource: result.suggestedSource,
            nextSteps: result.nextSteps,
          })}\n`,
        );
      } else {
        const emit = createEmitter(options);
        emit.info(result.message);
        emit.blank();
        emit.next(
          result.suggestedSource
            ? `vana data show ${result.suggestedSource}`
            : "vana sources",
        );
      }
      return 1;
    }
    if (result.error === "dataset_not_found") {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            error: result.error,
            source: result.source,
            message: result.message,
            nextSteps: result.nextSteps,
            ...(result.resultPath ? { resultPath: result.resultPath } : {}),
            ...(result.logPath ? { logPath: result.logPath } : {}),
          })}\n`,
        );
      } else {
        const emit = createEmitter(options);
        emit.info(result.message);
        if (result.resultPath || result.logPath) {
          emit.blank();
        }
        if (result.resultPath) {
          emit.keyValue(
            "Result file",
            formatDisplayPath(result.resultPath),
            "muted",
          );
        }
        if (result.logPath) {
          emit.keyValue("Run log", formatDisplayPath(result.logPath), "muted");
        }
        emit.blank();
        emit.next(`vana connect ${result.source}`);
      }
      return 1;
    }
    // dataset_read_failed
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ error: result.error, source: result.source, path: result.path, message: result.message })}\n`,
      );
    } else {
      createEmitter(options).info(result.message);
    }
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        source: result.source,
        name: result.name,
        path: result.path,
        summary: result.summary,
        lastRunAt: result.lastRunAt,
        dataState: result.dataState,
        nextSteps: result.nextSteps,
        data: result.data,
      })}\n`,
    );
    return 0;
  }

  const emit = createEmitter(options);
  const state = await readCliState();
  const record = state.sources[result.source];
  emit.title(`${result.name} data`);
  emit.blank();
  if (result.summary) {
    for (const line of result.summary.lines) {
      emit.detail(line);
    }
    emit.blank();
  }
  emit.keyValue("Path", formatDisplayPath(result.path), "muted");
  if (record?.lastRunAt) {
    emit.keyValue("Updated", formatTimestamp(record.lastRunAt), "muted");
  }
  if (record?.dataState === "ingested_personal_server") {
    emit.keyValue("State", "Synced to Personal Server", "success");
  } else if (record?.dataState === "ingest_failed") {
    emit.keyValue("State", "Saved locally, sync failed", "warning");
  } else {
    emit.keyValue("State", "Saved locally", "muted");
  }
  emit.blank();
  if (result.datasetCount > 1) {
    emit.next("vana data list");
  } else {
    emit.next(`vana connect ${result.source}`);
  }
  return 0;
}

async function runDataPath(
  source: string,
  options: GlobalOptions,
): Promise<number> {
  const sourceLabels = createSourceLabelMap(await loadRegistrySources());
  const state = await readCliState();
  const resultPath = state.sources[source]?.lastResultPath;

  if (!resultPath) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          error: "dataset_not_found",
          source,
          name: displaySource(source, sourceLabels),
          message: `No collected dataset found for ${displaySource(source, sourceLabels)}. Run \`vana connect ${source}\` first.`,
        })}\n`,
      );
    } else {
      createEmitter(options).info(
        `No collected dataset found for ${displaySource(source, sourceLabels)}. Run \`vana connect ${source}\` first.`,
      );
    }
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        source,
        name: displaySource(source, sourceLabels),
        path: resultPath,
        lastRunAt: state.sources[source]?.lastRunAt ?? null,
        dataState: state.sources[source]?.dataState ?? null,
        nextSteps: [
          `Inspect the dataset with \`vana data show ${source}\`.`,
          `Reconnect ${displaySource(source, sourceLabels)} with \`vana connect ${source}\`.`,
        ],
      })}\n`,
    );
  } else {
    process.stdout.write(`${formatDisplayPath(resultPath)}\n`);
  }
  return 0;
}

async function runLogs(
  source: string | undefined,
  options: GlobalOptions,
): Promise<number> {
  const sourceLabels = createSourceLabelMap(await loadRegistrySources());
  const state = await readCliState();
  const records = Object.entries(state.sources)
    .filter(([, entry]) => Boolean(entry?.lastLogPath))
    .map(([sourceId, entry]) => ({
      source: sourceId,
      name: displaySource(sourceId, sourceLabels),
      path: entry?.lastLogPath ?? "",
      lastRunAt: entry?.lastRunAt ?? null,
      lastRunOutcome: entry?.lastRunOutcome ?? null,
      dataState: (entry?.dataState === "collected_local" ||
      entry?.dataState === "ingested_personal_server" ||
      entry?.dataState === "ingest_failed"
        ? entry.dataState
        : null) as SourceStatus["dataState"] | null,
    }))
    .sort(compareLogRecordOrder);
  const logSummary = {
    attentionCount: records.filter((record) =>
      isAttentionLog(record.lastRunOutcome, record.dataState),
    ).length,
    successfulCount: records.filter(
      (record) =>
        record.dataState === "collected_local" ||
        record.dataState === "ingested_personal_server",
    ).length,
    localCount: records.filter(
      (record) => record.dataState === "collected_local",
    ).length,
    syncedCount: records.filter(
      (record) => record.dataState === "ingested_personal_server",
    ).length,
  };

  if (source) {
    const match = records.find((record) => record.source === source);
    if (!match) {
      const payload = {
        error: "log_not_found",
        source,
        message: `No stored run log found for ${displaySource(source, sourceLabels)}.`,
        nextSteps: [
          `Run \`vana connect ${source}\` to create a new log.`,
          ...(records.length > 0
            ? ["Run `vana logs` to inspect other logs."]
            : []),
        ],
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        const emit = createEmitter(options);
        emit.info(payload.message);
        emit.blank();
        emit.next(`vana connect ${source}`);
      }
      return 1;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(match)}\n`);
    } else {
      process.stdout.write(`${formatDisplayPath(match.path)}\n`);
    }
    return 0;
  }

  const nextSteps = buildLogsNextSteps(records);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        count: records.length,
        latestLog: records[0] ?? null,
        nextSteps,
        summary: logSummary,
        logs: records,
      })}\n`,
    );
    return 0;
  }

  const emit = createEmitter(options);
  emit.title(records.length > 0 ? `Run logs (${records.length})` : "Run logs");
  emit.blank();

  if (records.length === 0) {
    emit.info("No stored run logs yet.");
    emit.blank();
    emit.next("vana connect");
    return 0;
  }

  emit.info(
    // Counts in a sentence: the sections below carry the headings.
    joinOverviewParts([
      logSummary.attentionCount > 0
        ? `${logSummary.attentionCount} need${logSummary.attentionCount === 1 ? "s" : ""} attention`
        : "",
      logSummary.successfulCount > 0
        ? `${logSummary.successfulCount} successful`
        : "",
      logSummary.localCount > 0 ? `${logSummary.localCount} local` : "",
      logSummary.syncedCount > 0 ? `${logSummary.syncedCount} synced` : "",
    ]),
  );
  emit.blank();

  const groups = [
    {
      title: "Needs attention",
      items: records.filter((record) =>
        isAttentionLog(record.lastRunOutcome, record.dataState),
      ),
    },
    {
      title: "Successful runs",
      items: records.filter(
        (record) => !isAttentionLog(record.lastRunOutcome, record.dataState),
      ),
    },
  ].filter((group) => group.items.length > 0);

  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) {
      emit.blank();
    }
    emit.section(formatCountLabel(group.title, group.items.length));
    for (const record of group.items) {
      emit.sourceTitle(record.name, [
        {
          text: formatLogOutcomeLabel(record.lastRunOutcome, record.dataState),
          tone: toneForLogOutcome(record.lastRunOutcome, record.dataState),
        },
      ]);
      emit.keyValue("Path", formatDisplayPath(record.path), "muted");
      if (record.lastRunAt) {
        emit.keyValue("Updated", formatTimestamp(record.lastRunAt), "muted");
      }
    }
  });

  emit.blank();
  if (nextSteps.length > 0) {
    const command = extractCommand(nextSteps[0]);
    if (command) {
      emit.next(command);
    } else {
      emit.detail(`Next: ${nextSteps[0]}`);
    }
  }
  return 0;
}

async function runSourceDetail(
  source: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const registrySources = await loadRegistrySources();
  const state = await readCliState();
  const { match, suggestion } = lookupSource(source, registrySources);

  if (!match) {
    const message = formatUnknownSourceMessage(source, suggestion);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ error: "unknown_source", source, message, suggestedSource: suggestion?.id ?? null })}\n`,
      );
    } else {
      emit.info(message);
    }
    return 1;
  }

  const stored = state.sources[match.id];
  const metadata =
    match.origin === "local"
      ? null
      : await readCachedConnectorMetadata(match.id, getConnectorCacheDir());
  const scopes =
    match.origin === "local" && match.localPath
      ? await readLocalConnectorScopes(match.localPath, match.id)
      : (metadata?.scopes ?? []);
  const sourceStatus = stored
    ? ({
        source: match.id,
        installed: Boolean(stored.connectorInstalled),
        sessionPresent: stored.sessionPresent ?? false,
        lastRunOutcome: stored.lastRunOutcome ?? null,
        dataState: stored.dataState as SourceStatus["dataState"],
      } as SourceStatus)
    : undefined;
  const badge = sourceStatus ? getSourceBadge(sourceStatus) : undefined;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        id: match.id,
        name: match.name,
        company: match.company,
        description: match.description,
        version: match.version ?? stored?.connectorVersion,
        exportFrequency: match.exportFrequency ?? stored?.exportFrequency,
        authMode: match.authMode,
        ...(match.origin === "local"
          ? { origin: "local", localPath: match.localPath }
          : {}),
        scopes,
        scopeLabels: scopes.map((s) => s.label),
        connectorVersion: stored?.connectorVersion,
        lastCollectedAt: stored?.lastCollectedAt,
        dataState: stored?.dataState,
      })}\n`,
    );
    return 0;
  }

  const iconPrefix = await renderIconInline(match.id);
  const badgeList: Array<{ text: string; tone?: RenderTone }> = [];
  if (badge && badge.label !== "new") {
    badgeList.push({ text: badge.label, tone: badge.style });
  }
  if (match.origin === "local") {
    badgeList.push({ text: "local", tone: "warning" });
  }
  emit.sourceTitle(`${iconPrefix}${match.name}`, badgeList);
  emit.blank();
  if (match.origin === "local" && match.localPath) {
    emit.info(`Runs unsigned source from ${match.localPath}.`);
    emit.blank();
  } else if (match.description) {
    emit.info(cleanDescription(match.description));
    emit.blank();
  }

  if (scopes.length > 0) {
    emit.section("Collects");
    for (const scope of scopes) {
      if (scope.description) {
        emit.keyValue(
          scope.label,
          cleanDescription(scope.description),
          "muted",
        );
      } else {
        emit.bullet(scope.label);
      }
    }
  }

  if (
    stored?.connectorVersion &&
    match.version &&
    stored.connectorVersion !== match.version
  ) {
    emit.blank();
    emit.detail(
      `A newer connector version is available (${match.version}). Reconnect to update.`,
    );
  }

  emit.blank();
  emit.next(`vana connect ${match.id}`);
  return 0;
}

async function runCollect(
  source: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const state = await readCliState();
  const stored = state.sources[source];

  if (!stored || !stored.connectorInstalled) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          error: "not_previously_connected",
          source,
          message: `Source "${source}" has not been connected yet. Run \`vana connect ${source}\` first.`,
        })}\n`,
      );
    } else {
      emit.info(
        `Source "${source}" has not been connected yet. Run \`vana connect ${source}\` first.`,
      );
    }
    return 1;
  }

  return runConnect(source, options, { verb: "Collect" });
}

type SyncRetryMode = "automatic" | "manual";

interface SyncPendingResult {
  syncedCount: number;
  sourceResults: Array<{
    source: string;
    scopeResults?: Array<{ scope: string; status: string; error?: string }>;
  }>;
}

function isPendingSyncDataState(
  dataState: SourceStatus["dataState"] | null | undefined,
): boolean {
  return dataState === "collected_local" || dataState === "ingest_unavailable";
}

function shouldRetryPendingSource(
  stored: StoredSourceState | undefined,
  mode: SyncRetryMode,
): boolean {
  if (!stored?.lastResultPath) {
    return false;
  }

  if (isPendingSyncDataState(stored.dataState as SourceStatus["dataState"])) {
    return true;
  }

  if (mode === "manual") {
    return (
      stored.dataState === "ingest_failed" ||
      stored.ingestScopes?.some((scope) => scope.status === "failed") === true
    );
  }

  return false;
}

function buildRetryOptions(
  stored: StoredSourceState | undefined,
  mode: SyncRetryMode,
): IngestResultOptions | undefined {
  if (!stored) {
    return undefined;
  }

  if (mode !== "manual") {
    return undefined;
  }

  const failedScopes =
    stored.ingestScopes
      ?.filter((scope) => scope.status === "failed")
      .map((scope) => scope.scope) ?? [];

  return failedScopes.length > 0 ? { scopes: failedScopes } : undefined;
}

function mergeIngestScopes(
  previous: StoredSourceState["ingestScopes"],
  current: Array<{ scope: string; status: string; error?: string }> | undefined,
): StoredSourceState["ingestScopes"] | undefined {
  if (!previous && !current) {
    return undefined;
  }

  const merged = new Map<
    string,
    {
      scope: string;
      status: "stored" | "failed";
      syncedAt?: string;
      error?: string;
    }
  >();

  for (const scope of previous ?? []) {
    merged.set(scope.scope, { ...scope });
  }

  const now = new Date().toISOString();
  for (const scope of current ?? []) {
    merged.set(scope.scope, {
      scope: scope.scope,
      status: scope.status === "stored" ? "stored" : "failed",
      syncedAt:
        scope.status === "stored" ? now : merged.get(scope.scope)?.syncedAt,
      error: scope.status === "failed" ? scope.error : undefined,
    });
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.scope.localeCompare(right.scope),
  );
}

function deriveSyncedDataState(
  scopes: StoredSourceState["ingestScopes"],
  fallback: SourceStatus["dataState"] | null | undefined,
): SourceStatus["dataState"] {
  if (!scopes || scopes.length === 0) {
    return fallback ?? "ingest_unavailable";
  }

  const storedCount = scopes.filter(
    (scope) => scope.status === "stored",
  ).length;
  const failedCount = scopes.filter(
    (scope) => scope.status === "failed",
  ).length;

  if (storedCount === 0 && failedCount > 0) {
    return "ingest_failed";
  }

  return "ingested_personal_server";
}

function summarizeSyncError(
  scopes: StoredSourceState["ingestScopes"],
): string | null {
  const failedScopes =
    scopes?.filter((scope) => scope.status === "failed") ?? [];
  if (failedScopes.length === 0) {
    return null;
  }

  return failedScopes
    .map((scope) => `${scope.scope}: ${scope.error ?? "sync failed"}`)
    .join("; ");
}

async function syncPendingSources(
  target: PersonalServerTarget,
  mode: SyncRetryMode,
): Promise<SyncPendingResult> {
  const state = await readCliState();
  const pendingSources = Object.entries(state.sources).filter(([, stored]) =>
    shouldRetryPendingSource(stored, mode),
  );

  if (pendingSources.length === 0) {
    return { syncedCount: 0, sourceResults: [] };
  }

  let syncedCount = 0;
  const sourceResults: SyncPendingResult["sourceResults"] = [];

  for (const [source, stored] of pendingSources) {
    if (!stored?.lastResultPath) {
      continue;
    }

    const ingestOptions = buildRetryOptions(stored, mode);
    const ingestEvents = await ingestResult(
      source,
      stored.lastResultPath,
      target,
      ingestOptions,
    );

    const resultEvent = ingestEvents.find(
      (event) =>
        event.type === "ingest-complete" ||
        event.type === "ingest-partial" ||
        event.type === "ingest-failed",
    );
    const mergedScopes = mergeIngestScopes(
      stored.ingestScopes,
      resultEvent?.scopeResults,
    );
    const ingestCompleted = ingestEvents.some(
      (event) => event.type === "ingest-complete",
    );
    const ingestPartial = ingestEvents.some(
      (event) => event.type === "ingest-partial",
    );

    if (ingestCompleted || ingestPartial) {
      syncedCount++;
      const dataState = deriveSyncedDataState(
        mergedScopes,
        stored.dataState as SourceStatus["dataState"] | null | undefined,
      );
      await updateSourceState(source, {
        dataState,
        ingestScopes: mergedScopes,
        lastError: summarizeSyncError(mergedScopes),
        // The run's failed sync is now done; leaving the outcome would keep
        // the source under "Needs attention".
        ...(stored.lastRunOutcome === CliOutcomeStatus.INGEST_FAILED &&
        dataState === "ingested_personal_server"
          ? { lastRunOutcome: CliOutcomeStatus.CONNECTED_AND_INGESTED }
          : {}),
      });
    }

    sourceResults.push({ source, scopeResults: resultEvent?.scopeResults });
  }

  return { syncedCount, sourceResults };
}

async function runCollectAll(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const startedAt = new Date().toISOString();
  const state = await readCliState();
  const dueSources = Object.entries(state.sources)
    .filter(
      ([, stored]) =>
        stored?.connectorInstalled &&
        isCollectionDue(stored.exportFrequency, stored.lastCollectedAt),
    )
    .map(([id]) => id);

  const results = new Map<string, CollectAllSourceResult>();
  let connectExitCode: number = CliExitCode.OK;
  for (const source of dueSources) {
    const result = await runConnect(source, options, { verb: "Collect" });
    if (result !== CliExitCode.OK) {
      connectExitCode = result;
    }
    const after = await readCliState();
    results.set(
      source,
      classifyCollectedSource(source, result, after.sources[source]),
    );
  }

  let syncedPendingCount = 0;
  const target = await detectPersonalServerTarget();
  // Pending data waits for this account's own server; the one answering here
  // may be another account's.
  const foreign = personalServerOwnerMismatch(
    target.health?.owner,
    loadCredentials()?.account?.address,
  );
  if (target.state === "available" && foreign && !options.json) {
    process.stderr.write(
      `Pending data not synced: the Personal Server at ${target.url} belongs to ${formatAddress(foreign.owner)}, not to you. Start yours with \`vana server start\`.\n`,
    );
  }
  if (target.state === "available" && !foreign) {
    const synced = await syncPendingSources(target, "automatic");
    syncedPendingCount = synced.syncedCount;
    for (const entry of synced.sourceResults) {
      if (results.get(entry.source)?.outcome === "collect_failed") continue;
      const failed = entry.scopeResults?.find((r) => r.status === "failed");
      results.set(
        entry.source,
        failed
          ? {
              source: entry.source,
              outcome: "sync_failed",
              ...(failed.error ? { error: failed.error } : {}),
            }
          : { source: entry.source, outcome: "ok" },
      );
    }
  }

  const sourceResults = [...results.values()];
  // A source whose run already failed keeps that code; otherwise a failed
  // or skipped sync makes the whole run fail, so a scheduler (and anyone
  // reading its log) sees it.
  const exitCode =
    connectExitCode !== CliExitCode.OK
      ? connectExitCode
      : collectAllExitCode(sourceResults);

  if (options.json) {
    if (dueSources.length === 0) {
      const message =
        syncedPendingCount > 0
          ? `Synced ${syncedPendingCount} pending dataset(s).`
          : "No sources are due for collection.";
      process.stdout.write(
        `${JSON.stringify({ message, count: 0, syncedPendingCount, sources: sourceResults })}\n`,
      );
    }
  } else {
    // Failures go to stderr even under --quiet: for a scheduled run this is
    // the only line its log will ever hold.
    const lines = describeCollectAllFailures(sourceResults);
    if (lines.length > 0) {
      const stamp =
        process.env[SCHEDULED_RUN_ENV] === "1" ? `[${startedAt}] ` : "";
      process.stderr.write(`${stamp}${lines.join("\n")}\n`);
    } else if (dueSources.length === 0) {
      emit.info(
        syncedPendingCount > 0
          ? `Synced ${syncedPendingCount} pending dataset(s).`
          : "No sources are due for collection.",
      );
    }
  }

  if (process.env[SCHEDULED_RUN_ENV] === "1") {
    await recordScheduledRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      logPath: path.join(getLogsDir(), "schedule.log"),
      sources: sourceResults,
    }).catch(() => undefined);
  }

  return exitCode;
}

async function runServerSync(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);
  const target = await detectPersonalServerTarget();
  trackActiveTelemetryEvent("server_sync_started");

  if (target.state !== "available") {
    trackActiveTelemetryEvent("server_sync_failed", {
      errorClass: "personal_server_unavailable",
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          error: "personal_server_unavailable",
          message:
            "Personal Server is not available. Run `vana server set-url <url>` to configure.",
        })}\n`,
      );
    } else {
      emit.info(
        "Personal Server is not available. Run `vana server set-url <url>` to configure.",
      );
    }
    return 1;
  }

  const mismatch = personalServerOwnerMismatch(
    target.health?.owner,
    loadCredentials()?.account?.address,
  );
  if (mismatch) {
    let useIt = false;
    if (!cannotAskAboutForeignServer(options) && !options.json) {
      useIt = await confirm({
        message: `The Personal Server at ${target.url} belongs to ${formatAddress(mismatch.owner)}. Sync your pending data into it?`,
        default: false,
        ...vanaPromptTheme,
      });
    }
    if (!useIt) {
      const message = foreignServerRefusal(target.url, mismatch.owner);
      trackActiveTelemetryEvent("server_sync_failed", {
        errorClass: "personal_server_not_yours",
      });
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            error: "personal_server_not_yours",
            message,
            url: target.url,
            owner: mismatch.owner,
            account: mismatch.account,
          })}\n`,
        );
      } else {
        emit.info(message);
      }
      return CliExitCode.SERVER_UNAVAILABLE;
    }
  }

  const syncResult = await syncPendingSources(target, "manual");
  const storedScopeCount = syncResult.sourceResults.reduce(
    (total, entry) =>
      total +
      (entry.scopeResults?.filter(
        (scopeResult) => scopeResult.status === "stored",
      ).length ?? 0),
    0,
  );
  const failedScopeCount = syncResult.sourceResults.reduce(
    (total, entry) =>
      total +
      (entry.scopeResults?.filter(
        (scopeResult) => scopeResult.status === "failed",
      ).length ?? 0),
    0,
  );

  if (syncResult.sourceResults.length === 0) {
    trackActiveTelemetryEvent("server_sync_completed", {
      storedScopeCount: 0,
      failedScopeCount: 0,
      metadata: { syncedSources: 0 },
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ message: "No pending datasets to sync.", syncedCount: 0 })}\n`,
      );
    } else {
      emit.info("No pending datasets to sync.");
    }
    return 0;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ message: `Synced ${syncResult.syncedCount} dataset(s).`, syncedCount: syncResult.syncedCount })}\n`,
    );
  } else {
    // Show per-scope results with scope manifest style
    const renderer = createHumanRenderer();
    for (const entry of syncResult.sourceResults) {
      if (entry.scopeResults && entry.scopeResults.length > 0) {
        emit.info(`${entry.source}:`);
        for (const sr of entry.scopeResults) {
          if (sr.status === "stored") {
            emit.info(`  ${renderer.theme.success("\u2713")} ${sr.scope}`);
          } else {
            const errDetail = sr.error ? humanizeIssue(sr.error) : "Failed";
            emit.info(
              `  ${renderer.theme.error("\u2717")} ${sr.scope} ${renderer.theme.muted(`\u2014 ${errDetail}`)}`,
            );
          }
        }
      }
    }
    emit.blank();
    const allStored = syncResult.sourceResults.every(
      (entry) =>
        !entry.scopeResults ||
        entry.scopeResults.every((sr) => sr.status === "stored"),
    );
    const allFailuresAuth = syncResult.sourceResults.every((entry) =>
      (entry.scopeResults ?? []).every(
        (sr) => sr.status === "stored" || isPersonalServerAuthError(sr.error),
      ),
    );
    if (storedScopeCount === 0 && failedScopeCount > 0) {
      // A success tick here reads as done to a person and exits 0 to a
      // script, when in fact nothing reached the server at all.
      emit.info(
        `${renderer.theme.error("✗")} Synced nothing: ${failedScopeCount} scope(s) failed.`,
      );
      emit.blank();
      if (allFailuresAuth) {
        emit.detail(
          "Your Personal Server requires authentication. Run `vana login` to authenticate, then `vana server sync`.",
        );
        emit.next("vana login");
      } else {
        emit.next("vana doctor");
      }
    } else {
      emit.success(
        failedScopeCount > 0
          ? `Synced ${syncResult.syncedCount} dataset(s), ${failedScopeCount} scope(s) failed.`
          : `Synced ${syncResult.syncedCount} dataset(s).`,
      );
      emit.blank();
      emit.next(allStored ? "vana data list" : "vana server sync");
    }
  }
  trackActiveTelemetryEvent("server_sync_completed", {
    storedScopeCount,
    failedScopeCount,
    metadata: { syncedSources: syncResult.syncedCount },
  });
  // Nothing stored and something failed is a failed run, whatever the
  // per-scope lines said.
  return storedScopeCount === 0 && failedScopeCount > 0 ? 1 : 0;
}

/**
 * What `login` should say about the Personal Server.
 *
 * The stored `personal_server` credential is only ever filled by a
 * self-hosted login, because the account token flow carries no Personal
 * Server session. Reporting that field directly meant a person with a
 * healthy, running server was told `personal_server: null`, which reads as
 * "you do not have one". This reports the server the CLI would actually
 * talk to, and says plainly whether the CLI holds a session for it.
 */
async function describeLoginPersonalServer(
  credentialed: { url: string } | null | undefined,
): Promise<{ url: string; authenticated: boolean; source: string } | null> {
  if (credentialed?.url) {
    return { url: credentialed.url, authenticated: true, source: "login" };
  }
  try {
    const target = await detectPersonalServerTarget();
    if (target.state === "available" && target.url) {
      return {
        url: target.url,
        authenticated: false,
        source: target.source ?? "detected",
      };
    }
  } catch {
    // Detection is a courtesy here; never fail a good login over it.
  }
  return null;
}

async function runServerData(
  scope: string | undefined,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const target = await detectPersonalServerTarget();
  const state = await readCliState();

  // Gather locally-known scopes from state
  const localScopes: Array<{ scope: string; source: string; status: string }> =
    [];
  for (const [src, stored] of Object.entries(state.sources)) {
    if (stored?.ingestScopes) {
      for (const is of stored.ingestScopes) {
        localScopes.push({ scope: is.scope, source: src, status: is.status });
      }
    }
  }

  // If PS is available, try to list remote scopes via client
  let remoteScopes: Array<{ scope: string; count: number }> = [];
  let didQueryRemoteScopes = false;
  let remoteScopeFallbackReason: string | undefined;
  if (target.state === "available" && target.url) {
    const auth = resolvePersonalServerAuthConfig(target.url);
    try {
      if (auth?.type === "bearerToken") {
        const { createPersonalServerClient: createClient } =
          await import("../personal-server/client.js");
        const client = createClient({
          url: target.url,
          auth,
        });
        didQueryRemoteScopes = true;
        remoteScopes = await client.listScopes(scope);
      }
    } catch (err) {
      remoteScopeFallbackReason =
        err instanceof Error ? err.message : "unknown error";
    }
  }

  // Use remote scopes if available, otherwise fall back to local
  const scopeList = didQueryRemoteScopes
    ? remoteScopes.map((s) => ({
        scope: s.scope,
        detail: `${s.count} version${s.count !== 1 ? "s" : ""}`,
      }))
    : localScopes
        .filter((s) => s.status === "stored")
        .filter((s) => !scope || s.scope.startsWith(scope))
        .map((s) => ({ scope: s.scope, detail: "1 version" }));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        count: scopeList.length,
        scopes: scopeList,
        source: didQueryRemoteScopes ? "remote" : "local",
        ...(remoteScopeFallbackReason ? { remoteScopeFallbackReason } : {}),
      })}\n`,
    );
    return 0;
  }

  if (scopeList.length === 0) {
    emit.info(
      didQueryRemoteScopes
        ? "No data on your Personal Server."
        : "No scopes found.",
    );
    if (target.state !== "available") {
      emit.detail(
        "Personal Server is not available. Showing locally-known scopes only.",
      );
    } else if (!didQueryRemoteScopes) {
      // The server is up but was never asked, so an empty list here is not
      // evidence that the server holds nothing.
      emit.detail(
        "The server was not queried, so this is only what this machine knows. Run `vana login` to read what the server actually holds.",
      );
    }
    return 0;
  }

  for (const entry of scopeList) {
    emit.keyValue(entry.scope, entry.detail, "muted");
  }

  if (!didQueryRemoteScopes && localScopes.length > 0) {
    emit.blank();
    emit.detail(
      "Showing locally-known scopes. Connect your Personal Server for live data.",
    );
  }

  return 0;
}

function getSourceBadge(source: SourceStatus): {
  label: string;
  style: "success" | "warning" | "error" | "muted";
} {
  if (
    source.dataState === "collected_local" ||
    source.dataState === "ingested_personal_server" ||
    source.dataState === "ingest_failed"
  ) {
    return { label: "connected", style: "success" };
  }

  if (
    source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT ||
    source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH
  ) {
    return { label: "needs login", style: "warning" };
  }

  if (
    source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR ||
    source.lastRunOutcome === CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR
  ) {
    return { label: "error", style: "error" };
  }

  return { label: "new", style: "muted" };
}

function isCollectionDue(
  frequency: string | undefined,
  lastCollectedAt: string | undefined,
): boolean {
  if (!frequency || !lastCollectedAt) {
    return true;
  }

  const lastMs = new Date(lastCollectedAt).getTime();
  if (Number.isNaN(lastMs)) {
    return true;
  }

  const now = Date.now();
  const elapsed = now - lastMs;
  const intervalMs = parseFrequencyToMs(frequency);
  return elapsed >= intervalMs;
}

function parseFrequencyToMs(frequency: string): number {
  const lower = frequency.toLowerCase().trim();
  if (lower === "daily") {
    return 24 * 60 * 60 * 1000;
  }
  if (lower === "weekly") {
    return 7 * 24 * 60 * 60 * 1000;
  }
  if (lower === "monthly") {
    return 30 * 24 * 60 * 60 * 1000;
  }

  const match = /^(\d+)\s*(h|d|m|w)$/i.exec(lower);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === "h") return value * 60 * 60 * 1000;
    if (unit === "d") return value * 24 * 60 * 60 * 1000;
    if (unit === "w") return value * 7 * 24 * 60 * 60 * 1000;
    if (unit === "m") return value * 30 * 24 * 60 * 60 * 1000;
  }

  // Default to daily if unparseable.
  return 24 * 60 * 60 * 1000;
}

async function renderIconInline(source: string): Promise<string> {
  const iconPath = findCachedIconPath(source);
  if (!iconPath) {
    return "";
  }
  try {
    // terminal-image is optional — not in package.json dependencies.
    // The `as string` cast prevents TypeScript from resolving the module at compile time.
    const terminalImage = (await import("terminal-image" as string)) as {
      default: {
        buffer: (
          input: Buffer,
          options?: { width?: number; height?: number },
        ) => Promise<string>;
      };
    };
    const imageBuffer = await fsp.readFile(iconPath);
    return await terminalImage.default.buffer(imageBuffer, {
      width: 2,
      height: 1,
    });
  } catch {
    return "";
  }
}

function findCachedIconPath(source: string): string | null {
  const cacheDir = getConnectorCacheDir();
  const extensions = [".png", ".svg", ".jpg", ".jpeg", ".webp"];
  for (const ext of extensions) {
    const candidate = path.join(cacheDir, `${source}.icon${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createEmitter(options: GlobalOptions): Emitter {
  const renderer = createHumanRenderer();

  return {
    event(event: CliEvent | CliOutcome) {
      getActiveTelemetrySession()?.trackCliEvent(event);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    },
    info(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${message}\n`);
    },
    blank() {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write("\n");
    },
    title(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.title(message)}\n`);
    },
    success(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.success(message)}\n`);
    },
    section(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.section(message)}\n`);
    },
    keyValue(label: string, value: string, tone: RenderTone = "muted") {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.keyValue(label, value, tone)}\n`);
    },
    detail(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.detail(message)}\n`);
    },
    next(command: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(
        `  ${renderer.theme.muted("Next:")} ${renderer.theme.code(command)}\n`,
      );
    },
    bullet(message: string) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(`${renderer.bullet(message)}\n`);
    },
    sourceTitle(
      name: string,
      badges: Array<{ text: string; tone?: RenderTone }> = [],
    ) {
      if (options.json || options.quiet) {
        return;
      }
      process.stdout.write(
        `${renderer.sourceTitle(
          name,
          badges.map((badge) => renderer.badge(badge.text, badge.tone)),
        )}\n`,
      );
    },
    badge(text: string, tone: RenderTone = "muted") {
      return renderer.badge(text, tone);
    },
    code(text: string) {
      return renderer.theme.code(text);
    },
  };
}

export function displaySource(
  source: string,
  labels: SourceLabelMap = {},
): string {
  return labels[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

function formatCountLabel(label: string, count: number): string {
  const normalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  return `${normalizedLabel} (${count})`;
}

function joinOverviewParts(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function humanizeField(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (match) => match.toUpperCase());
}

export function humanizeIssue(message: string): string {
  const scopeSummary = summarizeScopeErrors(message);
  if (scopeSummary) {
    return scopeSummary;
  }
  if (/checksum|mismatch/i.test(message)) {
    return "Connector is out of date. Will auto-update on next connect.";
  }
  const transportSummary = summarizeTransportError(message);
  if (transportSummary) {
    return transportSummary;
  }
  return message;
}

// "github.repos: HTTP 401: {...}; github.profile: HTTP 401: {...}", the
// per-scope sync error stored as one string.
const SCOPE_ERROR_PREFIX = /(?:^|;\s+)([a-z0-9_-]+(?:\.[a-z0-9_-]+)+):\s+/gi;

/**
 * One line for a per-scope sync error, with identical errors counted once:
 * "Authentication required (HTTP 401) for 6 scopes" instead of six raw
 * JSON bodies. Null when the message is not a per-scope list.
 */
function summarizeScopeErrors(message: string): string | null {
  const starts = [...message.matchAll(SCOPE_ERROR_PREFIX)];
  if (starts.length === 0 || starts[0].index !== 0) return null;
  const errors = starts.map((start, i) =>
    message
      .slice(
        (start.index ?? 0) + start[0].length,
        starts[i + 1]?.index ?? message.length,
      )
      .trim(),
  );
  // One "host.name: reason" is an ordinary message, not a scope list.
  if (errors.length === 1 && !/^HTTP\s+\d+/.test(errors[0])) return null;
  const groups = new Map<string, number>();
  errors.forEach((error) => {
    const status = error.match(/^HTTP\s+(\d+)\b/)?.[1];
    const summary = summarizeTransportError(error) ?? error;
    const label = status ? `${summary} (HTTP ${status})` : summary;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  });
  const entries = [...groups.entries()];
  if (entries.length === 1) {
    const [label, count] = entries[0];
    return `${label} for ${count} scope${count === 1 ? "" : "s"}`;
  }
  return `${starts.length} scopes failed: ${entries
    .map(([label, count]) => (count > 1 ? `${label} (${count})` : label))
    .join("; ")}`;
}

function summarizeTransportError(message: string): string | null {
  const httpMatch = message.match(/^HTTP\s+\d+:\s*(.+)$/s);
  if (!httpMatch) {
    return null;
  }

  const payload = httpMatch[1].trim();
  const parsed = parseTransportErrorPayload(payload);
  if (parsed) {
    return parsed.message;
  }

  const messageMatch = payload.match(/"message"\s*:\s*"([^"]+)"/);
  if (messageMatch) {
    return messageMatch[1];
  }

  return "Request failed";
}

function parseTransportErrorPayload(
  payload: string,
): { code?: string; message: string } | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const rawError =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error && typeof parsed.error === "object"
          ? ((parsed.error as Record<string, unknown>).errorCode ??
            (parsed.error as Record<string, unknown>).code)
          : undefined;
    const rawMessage =
      typeof parsed.message === "string"
        ? parsed.message
        : parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>).message
          : undefined;

    const code =
      typeof rawError === "string" || typeof rawError === "number"
        ? String(rawError)
        : undefined;
    const message =
      typeof rawMessage === "string" ? rawMessage : "Request failed";

    return { code, message: summarizeTransportCode(code, message) };
  } catch {
    return null;
  }
}

function summarizeTransportCode(
  code: string | undefined,
  message: string,
): string {
  if (code === "MISSING_AUTH" || /missing authentication/i.test(message)) {
    return "Authentication required";
  }
  if (code === "NO_SCHEMA" || /no schema registered/i.test(message)) {
    return "No schema registered";
  }
  if (code === "INVALID_SCOPE" || /scope must be/i.test(message)) {
    return "Unsupported scope";
  }

  return message;
}

function formatHumanSourceMessage(
  message: string,
  source: string,
  displayName: string,
): string {
  if (!message || source === displayName) {
    return message;
  }

  return message.replace(
    new RegExp(`\\b${escapeRegExp(source)}\\b`, "gi"),
    displayName,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getErrorLogPath(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "logPath" in error &&
    typeof (error as { logPath?: unknown }).logPath === "string"
  ) {
    return (error as { logPath: string }).logPath;
  }

  return null;
}

export async function gatherSourceStatuses(
  storedSources: Record<
    string,
    Awaited<ReturnType<typeof readCliState>>["sources"][string]
  >,
  metadata: SourceMetadataMap = {},
): Promise<SourceStatus[]> {
  const installedFiles = await listInstalledConnectorFiles();
  const sourceNames = new Set([
    ...Object.keys(storedSources),
    ...installedFiles.map((file) => file.source),
  ]);

  return [...sourceNames]
    .map((source): SourceStatus => {
      const stored = storedSources[source] ?? {};
      const details = metadata[source];
      // Collection Profiles live outside the legacy connector cache, so their
      // install is known only from the last connect.
      const installed =
        installedFiles.some((file) => file.source === source) ||
        (details?.runtime === "pdpp" && stored.connectorInstalled === true);
      const dataState: SourceStatus["dataState"] =
        stored.dataState === "ingested_personal_server"
          ? "ingested_personal_server"
          : stored.dataState === "ingest_unavailable"
            ? "ingest_unavailable"
            : stored.dataState === "ingest_failed"
              ? "ingest_failed"
              : stored.dataState === "collected_local"
                ? "collected_local"
                : "none";
      const ingestScopes = stored.ingestScopes;
      const syncedScopeCount =
        ingestScopes?.filter((s) => s.status === "stored").length ?? 0;
      const failedScopeCount =
        ingestScopes?.filter((s) => s.status === "failed").length ?? 0;
      const isOverdue =
        stored.lastCollectedAt && stored.exportFrequency
          ? isCollectionDue(stored.exportFrequency, stored.lastCollectedAt)
          : undefined;
      const suggestedNextCollectionAt =
        stored.lastCollectedAt && stored.exportFrequency
          ? new Date(
              new Date(stored.lastCollectedAt).getTime() +
                parseFrequencyToMs(stored.exportFrequency),
            ).toISOString()
          : undefined;
      return {
        source,
        name: details?.name,
        company: details?.company,
        description: details?.description,
        authMode:
          details?.authMode ?? inferInstalledAuthMode(installedFiles, source),
        runtime: details?.runtime,
        connectorVersion: stored.connectorVersion,
        exportFrequency: stored.exportFrequency,
        lastCollectedAt: stored.lastCollectedAt,
        connectionHealth: stored.connectionHealth,
        connectionHealthChangedAt: stored.connectionHealthChangedAt,
        connectionHealthReason: stored.connectionHealthReason,
        connectionHealthRetryable: stored.connectionHealthRetryable,
        installed,
        sessionPresent: stored.sessionPresent ?? false,
        lastRunAt: stored.lastRunAt ?? null,
        lastRunOutcome: stored.lastRunOutcome ?? null,
        dataState,
        lastError: stored.lastError ?? null,
        lastResultPath: stored.lastResultPath ?? null,
        lastLogPath: stored.lastLogPath ?? null,
        ingestScopes,
        skippedStreams: stored.skippedStreams,
        syncedScopeCount: syncedScopeCount > 0 ? syncedScopeCount : undefined,
        failedScopeCount: failedScopeCount > 0 ? failedScopeCount : undefined,
        suggestedNextCollectionAt,
        isOverdue,
      };
    })
    .sort(compareSourceStatusOrder);
}

export async function listInstalledConnectorFiles(): Promise<
  Array<{ source: string; path: string }>
> {
  const connectorsDir = getConnectorCacheDir();
  try {
    const results: Array<{ source: string; path: string }> = [];
    const entries = await fsp.readdir(connectorsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const companyDir = path.join(connectorsDir, entry.name);
      const files = await fsp.readdir(companyDir);
      for (const file of files) {
        if (!file.endsWith("-playwright.js")) {
          continue;
        }
        results.push({
          source: file.replace(/-playwright\.js$/, ""),
          path: path.join(companyDir, file),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function formatSourceStatusDetails(source: SourceStatus): SourceStatusDetail[] {
  const details: SourceStatusDetail[] = [];
  const displayName = source.name ?? displaySource(source.source);

  if (source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT) {
    details.push(
      source.lastError
        ? {
            kind: "text",
            message: `${source.lastError}. Run \`vana connect ${source.source}\` interactively.`,
          }
        : {
            kind: "text",
            message: `Run \`vana connect ${source.source}\` interactively.`,
          },
    );
  }

  if (source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    details.push({
      kind: "text",
      message: `Run \`vana connect ${source.source}\` without \`--no-input\` to complete the manual browser step.`,
    });
  }

  if (source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    details.push(
      source.lastError
        ? {
            kind: "text",
            message: formatHumanSourceMessage(
              source.lastError,
              source.source,
              displayName,
            ),
          }
        : {
            kind: "text",
            message: "The last connector run failed.",
          },
    );
  }

  if (source.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
    details.push(
      source.lastError
        ? {
            kind: "text",
            message: formatHumanSourceMessage(
              source.lastError,
              source.source,
              displayName,
            ),
          }
        : {
            kind: "text",
            message: "No connector is available for this source.",
          },
    );
  }

  if (!source.lastRunOutcome && source.installed) {
    details.push({
      kind: "text",
      message: `Run \`vana connect ${source.source}\` to collect data.`,
    });
  }

  if (
    source.lastRunOutcome === CliOutcomeStatus.CONNECTED_LOCAL_ONLY &&
    source.lastResultPath
  ) {
    details.push({
      kind: "text",
      message: `Inspect the latest local dataset with \`vana data show ${source.source}\`.`,
    });
  }

  if (
    source.sessionPresent &&
    (source.lastRunOutcome === CliOutcomeStatus.CONNECTED_LOCAL_ONLY ||
      source.lastRunOutcome === CliOutcomeStatus.CONNECTED_AND_INGESTED ||
      source.lastRunOutcome === CliOutcomeStatus.INGEST_FAILED)
  ) {
    details.push({
      kind: "row",
      label: "Session",
      value: "Session cached.",
      tone: "muted",
    });
  }

  if (source.lastRunOutcome === CliOutcomeStatus.CONNECTED_AND_INGESTED) {
    details.push({
      kind: "text",
      message: `Inspect the latest local dataset with \`vana data show ${source.source}\` or use your Personal Server copy.`,
    });
  }

  if (
    source.lastRunOutcome === CliOutcomeStatus.INGEST_FAILED &&
    source.dataState !== "ingested_personal_server"
  ) {
    details.push(
      source.lastError
        ? {
            kind: "text",
            message: `${humanizeIssue(source.lastError).replace(/\.$/, "")}. Inspect the local dataset with \`vana data show ${source.source}\`.`,
          }
        : {
            kind: "text",
            message: `Personal Server sync failed. Inspect the local dataset with \`vana data show ${source.source}\`.`,
          },
    );
  }

  if (source.dataState === "ingested_personal_server") {
    details.push({
      kind: "row",
      label: "State",
      value: "Synced to Personal Server",
      tone: "success",
    });
  } else if (source.dataState === "ingest_unavailable") {
    details.push({
      kind: "row",
      label: "State",
      value: "Pending sync to Personal Server",
      tone: "warning",
    });
  } else if (source.dataState === "ingest_failed") {
    details.push({
      kind: "row",
      label: "State",
      value: "Saved locally, sync failed",
      tone: "warning",
    });
  } else if (source.dataState === "collected_local") {
    details.push({
      kind: "row",
      label: "State",
      value: "Saved locally",
      tone: "muted",
    });
  }

  if (source.connectionHealthReason && source.connectionHealth !== "healthy") {
    details.push({
      kind: "row",
      label: "Cause",
      value: source.connectionHealthReason,
      tone: "muted",
    });
  }

  if (source.lastRunAt) {
    details.push({
      kind: "row",
      label: "Updated",
      value: `${formatTimestamp(source.lastRunAt)} (${formatRelativeTime(source.lastRunAt)})`,
      tone: "muted",
    });
  }

  if (source.lastResultPath && source.dataState !== "none") {
    details.push({
      kind: "row",
      label: "Path",
      value: formatDisplayPath(source.lastResultPath),
      tone: "muted",
    });
  }

  if (
    source.lastLogPath &&
    source.lastRunOutcome &&
    source.lastRunOutcome !== CliOutcomeStatus.CONNECTED_LOCAL_ONLY &&
    source.lastRunOutcome !== CliOutcomeStatus.CONNECTED_AND_INGESTED
  ) {
    details.push({
      kind: "row",
      label: "Run log",
      value: formatDisplayPath(source.lastLogPath),
      tone: "muted",
    });
  }

  return details;
}

export function buildStatusNextSteps(
  sources: SourceStatus[],
  sourceLabels: SourceLabelMap = {},
  runtime: CliStatus["runtime"] = "unhealthy",
  availableSources: Array<{ id: string; name: string; authMode?: string }> = [],
): string[] {
  const nextSteps: string[] = [];
  const attentionSources = [...sources]
    .filter(isSourceAttention)
    .sort(compareAttentionPriority);
  const highestPriority =
    attentionSources[0] ?? [...sources].sort(compareSourceStatusOrder)[0];
  const connectedSources = sources.filter(
    (source) =>
      source.dataState === "collected_local" ||
      source.dataState === "ingested_personal_server" ||
      source.dataState === "ingest_failed" ||
      source.dataState === "ingest_unavailable",
  );
  const needsAttention = attentionSources.length > 0;
  const highestPriorityLabel = highestPriority
    ? displaySource(highestPriority.source, sourceLabels)
    : null;
  const suggestedSource =
    availableSources.find((source) => source.authMode !== "legacy") ??
    availableSources[0];

  if (!highestPriority) {
    if (runtime === "installed") {
      if (suggestedSource) {
        nextSteps.push(
          `Connect ${suggestedSource.name} with \`vana connect ${suggestedSource.id}\`.`,
        );
      } else {
        nextSteps.push("Connect your first source with `vana connect`.");
      }
    } else if (runtime === "missing") {
      nextSteps.push("Install the local runtime with `vana setup`.");
      nextSteps.push("Inspect install health with `vana doctor`.");
    } else if (runtime === "unhealthy") {
      nextSteps.push("Inspect install health with `vana doctor`.");
    }
  } else if (highestPriority.dataState === "ingest_failed") {
    nextSteps.push(
      isPersonalServerAuthFailure(highestPriority)
        ? "Log in again with `vana login`, then run `vana server sync`."
        : `Reconnect ${highestPriorityLabel} with \`vana connect ${highestPriority.source}\`.`,
    );
  } else if (highestPriority.dataState === "ingest_unavailable") {
    nextSteps.push(
      "Retry pending Personal Server sync with `vana server sync`.",
    );
  } else if (
    highestPriority.connectionHealth === "needs_reauth" ||
    highestPriority.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT
  ) {
    nextSteps.push(
      `Reconnect ${highestPriorityLabel} with \`vana connect ${highestPriority.source}\`.`,
    );
    if (highestPriority.lastLogPath) {
      nextSteps.push(
        `Inspect the latest run log with \`vana logs ${highestPriority.source}\`.`,
      );
    }
  } else if (
    highestPriority.connectionHealth === "error" ||
    highestPriority.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR
  ) {
    nextSteps.push(
      `Retry ${highestPriorityLabel} with \`vana connect ${highestPriority.source}\`.`,
    );
    if (highestPriority.lastLogPath) {
      nextSteps.push(
        `Inspect the latest run log with \`vana logs ${highestPriority.source}\`.`,
      );
    }
  } else if (highestPriority.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    nextSteps.push(
      `Complete the manual browser step for ${highestPriorityLabel} with \`vana connect ${highestPriority.source}\`.`,
    );
    if (highestPriority.lastLogPath) {
      nextSteps.push(
        `Inspect the latest run log with \`vana logs ${highestPriority.source}\`.`,
      );
    }
  } else if (
    highestPriority.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE
  ) {
    nextSteps.push("Browse available sources with `vana sources`.");
    if (highestPriority.lastLogPath) {
      nextSteps.push(
        `Inspect the latest run log with \`vana logs ${highestPriority.source}\`.`,
      );
    }
  } else if (
    highestPriority.dataState === "collected_local" ||
    highestPriority.dataState === "ingested_personal_server"
  ) {
    if (connectedSources.length > 1) {
      nextSteps.push("Review your collected data with `vana data list`.");
    } else {
      nextSteps.push(
        `Inspect the latest dataset with \`vana data show ${highestPriority.source}\`.`,
      );
    }
  }

  if (connectedSources.length > 0 && needsAttention) {
    nextSteps.push(
      connectedSources.length > 1
        ? "Review the data you already collected with `vana data list`."
        : `Inspect the data you already collected with \`vana data show ${connectedSources[0].source}\`.`,
    );
  }

  if (
    sources.some((source) => source.installed || source.lastRunOutcome) &&
    (!needsAttention || connectedSources.length === 0)
  ) {
    nextSteps.push("Connect another source with `vana sources`.");
  }

  if (
    runtime !== "installed" ||
    sources.some(
      (source) =>
        source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR ||
        source.lastRunOutcome === CliOutcomeStatus.UNEXPECTED_INTERNAL_ERROR,
    )
  ) {
    nextSteps.push("Inspect install health with `vana doctor`.");
  }

  return [...new Set(nextSteps)];
}

export function buildSourcesNextSteps(
  recommendedSource:
    | {
        id: string;
        name: string;
        authMode?: "automated" | "interactive" | "legacy";
      }
    | null
    | undefined,
  connectedCount: number,
): string[] {
  const nextSteps: string[] = [];

  if (connectedCount > 0) {
    nextSteps.push("Inspect what you already collected with `vana data list`.");
  }
  if (recommendedSource) {
    nextSteps.push(
      `${
        recommendedSource.authMode === "legacy" ? "Complete" : "Connect"
      } ${recommendedSource.name} with \`vana connect ${recommendedSource.id}\`.`,
    );
  }
  nextSteps.push("Or browse the guided picker with `vana connect`.");

  return [...new Set(nextSteps)];
}

export function buildDataListNextSteps(
  datasetRecords: Array<{
    source: string;
    name?: string | null;
  }>,
  registrySources: Array<{
    id: string;
    authMode?: "automated" | "interactive" | "legacy";
  }>,
): string[] {
  if (datasetRecords.length === 0) {
    const suggestedSource =
      registrySources.find((source) => source.authMode !== "legacy") ??
      registrySources[0];

    return [
      suggestedSource
        ? `Collect your first dataset with \`vana connect ${suggestedSource.id}\`.`
        : "Collect your first dataset with `vana connect`.",
      "Check overall status with `vana status`.",
    ];
  }

  return [
    `Inspect ${datasetRecords[0].name ?? displaySource(datasetRecords[0].source)} with \`vana data show ${datasetRecords[0].source}\`.`,
    `Or print its path with \`vana data path ${datasetRecords[0].source}\`.`,
    "Connect another source with `vana sources`.",
  ];
}

export function buildDataShowNextSteps(
  source: string,
  datasetCount: number,
  sourceLabels: SourceLabelMap = {},
): string[] {
  return [
    `Print the path with \`vana data path ${source}\`.`,
    `Reconnect ${displaySource(source, sourceLabels)} with \`vana connect ${source}\`.`,
    ...(datasetCount > 1
      ? ["See all datasets with `vana data list`."]
      : ["Connect another source with `vana sources`."]),
  ];
}

function buildLogsNextSteps(
  records: Array<{
    source: string;
    lastRunOutcome: string | null;
    dataState: SourceStatus["dataState"] | null;
  }>,
): string[] {
  if (records.length === 0) {
    return [
      "Run `vana connect <source>` to create a connector run log.",
      "Check overall status with `vana status`.",
    ];
  }

  const attentionRecord = records.find((record) =>
    isAttentionLog(record.lastRunOutcome, record.dataState),
  );
  const successfulRecord = records.find(
    (record) => !isAttentionLog(record.lastRunOutcome, record.dataState),
  );
  return [
    attentionRecord
      ? `Inspect the latest issue log with \`vana logs ${attentionRecord.source}\`.`
      : `Print the latest log path with \`vana logs ${records[0].source}\`.`,
    ...(successfulRecord
      ? [
          `Inspect a successful run with \`vana logs ${successfulRecord.source}\`.`,
        ]
      : []),
    "Check overall status with `vana status`.",
  ];
}

/** Derive a human-readable message from a stored `connectionHealthReason`. */
export function formatHealthMessage(reason: string | undefined): string | null {
  if (!reason) return null;
  const colonIndex = reason.indexOf(": ");
  const prefix = colonIndex > 0 ? reason.slice(0, colonIndex) : reason;
  const detail =
    colonIndex > 0 ? reason.slice(colonIndex + 2).replace(/\.$/, "") : "";

  switch (prefix) {
    case "needs-input":
      return `Requires interactive login${detail ? `: ${detail}` : ""}.`;
    case "legacy-auth":
      return `Needed a browser window${detail ? `: ${detail}` : ""}. Reconnect interactively.`;
    case "runtime-error":
      return `Collection failed${detail ? ` — ${detail}` : ""}.`;
    case "error-result":
      return `Connector returned an error${detail ? `: ${detail}` : ""}.`;
    case "collection-complete":
      return null; // No message needed for healthy state
    default:
      return reason; // Graceful fallback for unknown prefixes
  }
}

/** Extract a `vana ...` command from a next-step sentence wrapped in backticks. */
function extractCommand(sentence: string): string | null {
  const match = sentence.match(/`(vana\s[^`]+)`/);
  return match ? match[1] : null;
}

// describeConnectTrust and buildConnectChoices removed — replaced by clack-based picker

function formatMissingConnectSourceMessage(
  source:
    | {
        id: string;
        name: string;
      }
    | undefined,
): string {
  if (source) {
    return `Specify a source. Start with \`vana connect ${source.id}\`, or run \`vana sources\` to see available options.`;
  }

  return "Specify a source. Run `vana sources` to see available options.";
}

// formatSourcePickerDescription removed — replaced by clack-based picker with hints

function normalizeArgv(argv: string[]): string[] {
  if (
    argv[2] === "connect" &&
    ["list", "status", "setup"].includes(argv[3] ?? "")
  ) {
    const mapping: Record<string, string> = {
      list: "sources",
      status: "status",
      setup: "setup",
    };
    return [argv[0], argv[1], mapping[argv[3]], ...argv.slice(4)];
  }

  return argv;
}

export function getCliVersion(): string {
  if (process.env.VANA_APP_ROOT) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(
          path.join(process.env.VANA_APP_ROOT, "package.json"),
          "utf8",
        ),
      ) as { version?: string };
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // Fall through to the repo/dev package metadata.
    }
  }

  try {
    const packageJson = require("../../package.json") as { version?: string };
    if (packageJson.version) {
      return packageJson.version;
    }
  } catch {
    // Fall through to the hard default.
  }

  return "0.0.0";
}

export function getCliChannel(version = getCliVersion()): "stable" | "canary" {
  if (version.includes("canary")) {
    return "canary";
  }

  const candidates = [process.env.VANA_APP_ROOT ?? "", process.execPath].map(
    (value) => value.replace(/\\/g, "/").toLowerCase(),
  );

  return candidates.some((normalizedPath) =>
    /\/releases\/canary-[^/]+(?:\/app)?$/.test(normalizedPath),
  )
    ? "canary"
    : "stable";
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** Where this file itself sits, which is what separates npm from a checkout. */
function getOwnModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

/** True when the CLI is running out of an npm install or an npx cache. */
function isPackagedUnderNodeModules(normalizedPath: string): boolean {
  return (
    normalizedPath.includes("/node_modules/vana-cli/") ||
    normalizedPath.includes("/_npx/")
  );
}

export function getCliInstallMethod(
  execPath = process.execPath,
  modulePath = getOwnModulePath(),
): CliInstallMethod {
  const candidates = [process.env.VANA_APP_ROOT ?? "", execPath].map(
    normalizePathForMatch,
  );

  for (const normalizedPath of candidates) {
    if (!normalizedPath) {
      continue;
    }
    if (normalizedPath.includes("/cellar/vana/")) {
      return "homebrew";
    }
    if (
      normalizedPath.includes("/.local/share/vana/") ||
      normalizedPath.includes("/appdata/local/vana/") ||
      normalizedPath.endsWith("/current/app") ||
      /\/releases\/[^/]+\/app$/.test(normalizedPath)
    ) {
      return "installer";
    }
  }

  // npm and npx both run under the user's own node, so execPath looks exactly
  // like a development checkout. Only the package's own location tells them
  // apart, and getting it wrong costs an npm user every update notification.
  if (
    modulePath &&
    isPackagedUnderNodeModules(normalizePathForMatch(modulePath))
  ) {
    return "npm";
  }

  for (const normalizedPath of candidates) {
    if (!normalizedPath) {
      continue;
    }
    if (
      normalizedPath.endsWith("/node") ||
      normalizedPath.endsWith("/node.exe") ||
      normalizedPath.includes("/.nvm/") ||
      normalizedPath.includes("/volta/") ||
      normalizedPath.includes("/pnpm/")
    ) {
      return "development";
    }
  }
  return "unknown";
}

function getCliAppRoot(execPath = process.execPath): string {
  return process.env.VANA_APP_ROOT ?? path.join(path.dirname(execPath), "app");
}

export function getDoctorAppRootPath(
  installMethod: CliInstallMethod,
  execPath = process.execPath,
): string | null {
  if (process.env.VANA_APP_ROOT) {
    return process.env.VANA_APP_ROOT;
  }
  if (installMethod === "homebrew" || installMethod === "installer") {
    return getCliAppRoot(execPath);
  }
  return null;
}

export function formatInstallMethodLabel(method: CliInstallMethod): string {
  switch (method) {
    case "homebrew":
      return "Homebrew";
    case "installer":
      return "Hosted installer";
    case "npm":
      return "npm";
    case "development":
      return "Development checkout";
    default:
      return "Unknown";
  }
}

export function getLifecycleCommands(
  installMethod: CliInstallMethod,
  channel: CliChannel,
  modulePath = getOwnModulePath(),
): { upgrade: string; uninstall: string } {
  switch (installMethod) {
    case "npm":
      // npx installs nothing, so there is nothing to upgrade or remove:
      // asking for @latest is the whole update story there.
      return normalizePathForMatch(modulePath).includes("/_npx/")
        ? {
            upgrade: "npx vana-cli@latest",
            uninstall:
              "npx leaves nothing installed. Remove ~/.vana for any state you no longer need.",
          }
        : {
            upgrade: "npm install -g vana-cli@latest",
            uninstall: "npm uninstall -g vana-cli",
          };
    case "homebrew":
      return {
        upgrade: "brew update && brew upgrade vana",
        uninstall: "brew uninstall vana",
      };
    case "installer":
      if (process.platform === "win32") {
        return {
          upgrade:
            'powershell -Command "irm https://raw.githubusercontent.com/vana-com/vana-cli/main/install/install.ps1 | iex"',
          uninstall:
            'powershell -Command "Remove-Item $env:LOCALAPPDATA\\Vana -Recurse -Force; Remove-Item $env:USERPROFILE\\.vana -Recurse -Force"',
        };
      }
      return {
        upgrade:
          channel === "canary"
            ? "curl -fsSL https://raw.githubusercontent.com/vana-com/vana-cli/feat/connect-cli-v1/install/install.sh | sh -s -- --version canary-feat-connect-cli-v1"
            : "curl -fsSL https://raw.githubusercontent.com/vana-com/vana-cli/main/install/install.sh | sh",
        uninstall:
          "rm -f ~/.local/bin/vana && rm -rf ~/.local/share/vana ~/.vana",
      };
    case "development":
      return {
        upgrade: "git pull && pnpm install && pnpm build",
        uninstall: "Remove the local checkout and any generated ~/.vana state.",
      };
    default:
      return {
        upgrade: "Reinstall vana using Homebrew or the hosted installer.",
        uninstall:
          "Remove the installed vana binary and any ~/.vana state you no longer need.",
      };
  }
}

/**
 * Pre-parse seed for the global options. Needed before commander runs (the
 * update-notifier suppression and the telemetry context read it); the
 * preAction hook overlays the authoritative parsed values afterwards.
 */
function extractGlobalOptions(rawArgv: string[]): GlobalOptions {
  // Everything after a bare "--" is positional; commander will not parse it
  // as options, so the seed must not either.
  const boundary = rawArgv.indexOf("--");
  const argv = boundary === -1 ? rawArgv : rawArgv.slice(0, boundary);
  let network: VanaNetworkName | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let candidate: string | undefined;
    if (argument === "--network") {
      candidate = argv[index + 1];
    } else if (argument.startsWith("--network=")) {
      candidate = argument.slice("--network=".length);
    }
    if (candidate && isVanaNetworkName(candidate)) {
      network = candidate;
    }
  }
  return {
    json: argv.includes("--json"),
    noInput: argv.includes("--no-input"),
    ipc: argv.includes("--ipc"),
    yes: argv.includes("--yes"),
    quiet: argv.includes("--quiet"),
    detach: argv.includes("--detach"),
    network,
  };
}

export function createSourceLabelMap(
  sources: Array<{ id: string; name: string }>,
): SourceLabelMap {
  return Object.fromEntries(sources.map((source) => [source.id, source.name]));
}

export function createSourceMetadataMap(
  sources: Array<{
    id: string;
    name: string;
    company?: string;
    description?: string;
    authMode?: "automated" | "interactive" | "legacy";
    runtime?: "legacy" | "pdpp";
  }>,
): SourceMetadataMap {
  return Object.fromEntries(
    sources.map((source) => [
      source.id,
      {
        name: source.name,
        company: source.company,
        description: source.description,
        authMode: source.authMode,
        runtime: source.runtime,
      },
    ]),
  );
}

// formatAuthModeBadge removed — replaced by clack-based picker with hints

export function getSourceStatusPresentation(source: SourceStatus): {
  label: string;
  tone: RenderTone;
} {
  if (!source.installed && !source.lastRunOutcome) {
    return { label: "not connected", tone: "muted" };
  }

  // Check dataState before early-returning on missing lastRunOutcome —
  // ingest can fail even when lastRunOutcome is unset
  if (source.dataState === "ingest_failed") {
    return { label: "sync failed", tone: "error" };
  }

  if (!source.lastRunOutcome) {
    return { label: "installed", tone: "success" };
  }

  if (source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT) {
    return { label: "needs input", tone: "warning" };
  }

  if (source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    return { label: "error", tone: "error" };
  }

  if (source.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
    return { label: "unavailable", tone: "warning" };
  }

  if (source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    return { label: "manual step", tone: "warning" };
  }

  if (source.dataState === "ingested_personal_server") {
    // Check per-scope state for more granular badges
    if (source.ingestScopes && source.ingestScopes.length > 0) {
      const storedCount = source.ingestScopes.filter(
        (s) => s.status === "stored",
      ).length;
      const failedCount = source.ingestScopes.filter(
        (s) => s.status === "failed",
      ).length;
      if (failedCount > 0 && storedCount > 0) {
        return { label: "partial sync", tone: "warning" };
      }
      if (failedCount > 0 && storedCount === 0) {
        return { label: "sync failed", tone: "error" };
      }
    }
    return { label: "synced", tone: "success" };
  }

  if (source.dataState === "ingest_unavailable") {
    return { label: "pending sync", tone: "warning" };
  }

  if (source.dataState === "collected_local") {
    return { label: "local", tone: "muted" };
  }

  return { label: "connected", tone: "success" };
}

export function toneForRuntime(runtime: CliStatus["runtime"]): RenderTone {
  if (runtime === "installed") {
    return "success";
  }
  if (runtime === "missing") {
    return "warning";
  }
  return "muted";
}

// formatProgressUpdate removed — replaced by ConnectRenderer scope methods

/**
 * Extract a human-readable scope name from a progress-update event.
 * The scope name comes from `phase.label` when `phase` is a structured object.
 */
function extractScopeName(event: {
  phase?: unknown;
  message?: string;
}): string | null {
  if (
    event.phase &&
    typeof event.phase === "object" &&
    "label" in event.phase &&
    typeof (event.phase as { label?: unknown }).label === "string"
  ) {
    return (event.phase as { label: string }).label;
  }
  return null;
}

/**
 * Format detail text for a completed scope (e.g. "8 found").
 * Extracts count from event.count or parses it from the message.
 */
function formatScopeDetail(event: {
  count?: number;
  message?: string;
}): string | undefined {
  if (typeof event.count === "number") {
    return `${event.count} found`;
  }
  // Try to extract a count from the completion message (e.g. "Complete! 8 repositories collected.")
  if (typeof event.message === "string") {
    const match = event.message.match(/(\d+)\s+\w+/);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

// shouldRenderStatusUpdate removed — status updates are silent in the new design

function inferInstalledAuthMode(
  installedFiles: Array<{ source: string; path: string }>,
  source: string,
): "automated" | "interactive" | "legacy" | undefined {
  const match = installedFiles.find((file) => file.source === source);
  if (!match) {
    return undefined;
  }

  try {
    const script = fs.readFileSync(match.path, "utf8");
    if (/page\.requestInput\(/.test(script)) {
      return "interactive";
    }
    if (/page\.(showBrowser|promptUser)\(/.test(script)) {
      return "legacy";
    }
    return "automated";
  } catch {
    return undefined;
  }
}

export async function loadRegistrySources() {
  try {
    return (
      (await listAvailableSources(findDataConnectorsDir() ?? undefined)) ?? []
    ).sort(compareRegistrySourceOrder);
  } catch {
    return [];
  }
}

function compareRegistrySourceOrder(
  left: AvailableSource,
  right: AvailableSource,
): number {
  return (
    rankAuthMode(left.authMode) - rankAuthMode(right.authMode) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
}

export function compareSourceStatusOrder(
  left: SourceStatus,
  right: SourceStatus,
): number {
  return (
    rankSourceStatus(left) - rankSourceStatus(right) ||
    compareRegistrySourceOrder(
      {
        id: left.source,
        name: left.name ?? displaySource(left.source),
        authMode: left.authMode,
      },
      {
        id: right.source,
        name: right.name ?? displaySource(right.source),
        authMode: right.authMode,
      },
    )
  );
}

const RESULT_METADATA_KEYS = new Set([
  "requestedScopes",
  "timestamp",
  "version",
  "platform",
  "exportSummary",
  "errors",
]);

// Collected content, looked for inside the scope wrappers connectors build
// (ChatGPT writes `{ conversations: [], total: 0 }`). Numbers and booleans on
// their own are counters and flags, not content.
function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasContent);
  }
  return false;
}

/**
 * Why a connector result holds no data despite recorded errors, or null when
 * it has data or recorded no error. A partial run (data plus errors) still
 * counts as collected; an empty result with no errors is an empty account.
 */
export function failedEmptyResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const errors = (Array.isArray(record.errors) ? record.errors : []).filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
  // No recorded error: an empty result is an empty account, not a failure.
  if (errors.length === 0) return null;
  // Judge by the data itself, not exportSummary.count: some connectors count
  // one stream only (ChatGPT counts conversations, not memories).
  const hasData = Object.entries(record).some(
    ([key, value]) => !RESULT_METADATA_KEYS.has(key) && hasContent(value),
  );
  if (hasData) return null;
  const cause =
    errors.find((entry) => entry.disposition === "fatal") ?? errors[0];
  return typeof cause.reason === "string" && cause.reason.trim()
    ? cause.reason
    : "The connector stopped before collecting any data.";
}

// Legacy connectors wrote their manual-step text for a host with a "Done"
// button. The CLI has none: the runtime checks by itself until the step is
// complete, so "click Done" would read as a button that never appears.
const CLICK_DONE =
  /,?\s*(?:then\s+)?(?:return here and\s+)?click "Done"\.?\s*$/i;

export function browserStepMessage(message: string): string {
  if (!CLICK_DONE.test(message)) return message;
  return `${message.replace(CLICK_DONE, ".")} Vana continues on its own once you're done.`;
}

export function isSourceAttention(source: SourceStatus): boolean {
  if (
    source.dataState === "ingest_failed" ||
    source.dataState === "ingest_unavailable"
  ) {
    return true;
  }

  // Synced, but some scopes did not make it ("partial sync").
  if (
    source.dataState === "ingested_personal_server" &&
    source.ingestScopes?.some((scope) => scope.status === "failed")
  ) {
    return true;
  }

  if (
    source.connectionHealth === "needs_reauth" ||
    source.connectionHealth === "error" ||
    source.connectionHealth === "stale"
  ) {
    return true;
  }

  return rankSourceStatus(source) <= 4;
}

/**
 * A source whose connector is no longer in the catalog and that never
 * collected anything: a leftover state entry (an id that was renamed, like
 * `claude-code` to `claude-code-local`) nothing can act on. Without a
 * catalog to compare against, nothing counts as retired.
 */
export function isRetiredSource(
  source: SourceStatus,
  registrySources: ReadonlyArray<{ id: string }>,
): boolean {
  return (
    registrySources.length > 0 &&
    !registrySources.some((entry) => entry.id === source.source) &&
    !hasCollectedData(source.dataState)
  );
}

/** Installed, or tried, but holds no data yet and needs nothing fixed. */
export function isSourceNotCollected(source: SourceStatus): boolean {
  return !isSourceAttention(source) && !hasCollectedData(source.dataState);
}

function compareAttentionPriority(
  left: SourceStatus,
  right: SourceStatus,
): number {
  const rank = (source: SourceStatus): number => {
    if (source.dataState === "ingest_failed") {
      return 0;
    }
    if (source.dataState === "ingest_unavailable") {
      return 1;
    }
    if (source.connectionHealth === "needs_reauth") {
      return 2;
    }
    if (source.connectionHealth === "error") {
      return 3;
    }
    if (source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
      return 4;
    }
    if (source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT) {
      return 5;
    }
    if (source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
      return 6;
    }
    if (source.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
      return 7;
    }
    return 8;
  };

  return rank(left) - rank(right) || compareSourceStatusOrder(left, right);
}

export function rankSourceStatus(source: SourceStatus): number {
  if (source.lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT) {
    return 0;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    return 1;
  }
  // A later `vana server sync` that stored the data settles a failed sync;
  // older state files still carry the failed outcome next to it.
  if (
    source.lastRunOutcome === CliOutcomeStatus.INGEST_FAILED &&
    source.dataState !== "ingested_personal_server"
  ) {
    return 2;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    return 3;
  }
  if (source.lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
    return 4;
  }
  if (source.dataState === "ingest_failed") {
    return 2;
  }
  if (source.dataState === "ingested_personal_server") {
    return 5;
  }
  if (source.dataState === "collected_local") {
    return 6;
  }
  if (source.installed) {
    return 7;
  }
  return 8;
}

function rankAuthMode(authMode: AvailableSource["authMode"]): number {
  if (authMode === "interactive") {
    return 0;
  }
  if (authMode === "automated") {
    return 1;
  }
  if (authMode === "legacy") {
    return 2;
  }
  return 3;
}

export async function readResultSummary(
  resultPath: string,
): Promise<{ lines: string[] } | null> {
  try {
    const raw = await fsp.readFile(resultPath, "utf8");
    return summarizeResultData(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function summarizeResultData(
  data: Record<string, unknown>,
): { lines: string[] } | null {
  const lines: string[] = [];
  const exportSummary =
    typeof data.exportSummary === "object" && data.exportSummary
      ? (data.exportSummary as Record<string, unknown>)
      : null;

  const username = findProfileUsername(data);
  if (username) {
    lines.push(`Profile: ${username}`);
  }

  // Connectors key their data either flat (`repositories`) or by scope
  // (`github.repositories`, holding `{ repositories: [...] }`); count every
  // list either way.
  const counted = new Set<string>();
  for (const scope of dataScopeKeys(data)) {
    const items = scopeList(scope, data[scope]);
    if (!items) {
      continue;
    }
    const leaf = scopeLeaf(scope);
    counted.add(normalizeCountKey(leaf));
    lines.push(`${humanizeKey(leaf)}: ${items.length}`);
    const previewLabel = NAMED_PREVIEW_LABELS[leaf];
    const preview = previewLabel
      ? summarizeNamedItems(items, previewLabel)
      : null;
    if (preview) {
      lines.push(preview);
    }
  }

  const details = exportSummary?.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    // `{ repositories: 10, events: 300 }`: add the counts no list showed.
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === "number" && !counted.has(normalizeCountKey(key))) {
        lines.push(`${humanizeKey(key)}: ${value}`);
      }
    }
  } else if (counted.size === 0) {
    if (typeof details === "string" && details.trim()) {
      lines.push(fixSingularCounts(details.trim()));
    } else if (
      typeof exportSummary?.count === "number" &&
      typeof exportSummary.label === "string" &&
      exportSummary.label.trim()
    ) {
      lines.push(
        fixSingularCounts(
          `${exportSummary.count} ${exportSummary.label.trim()}`,
        ),
      );
    }
  }

  return lines.length > 0 ? { lines } : null;
}

const NAMED_PREVIEW_LABELS: Record<string, string> = {
  repositories: "Latest repos",
  playlists: "Playlist names",
};

function findProfileUsername(data: Record<string, unknown>): string | null {
  const candidates = [
    data.profile,
    ...Object.entries(data)
      .filter(([key]) => key.includes(".") && scopeLeaf(key) === "profile")
      .map(([, value]) => value),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    for (const field of ["username", "login", "handle"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function normalizeCountKey(key: string): string {
  return key.replace(/[\s_-]+/g, "").toLowerCase();
}

/** `saved_items` / `savedItems` -> `Saved items`. */
function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies") && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (/(ss|x|ch|sh)es$/i.test(word)) {
    return word.slice(0, -2);
  }
  if (lower.endsWith("s") && !lower.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/** `1 playlists` -> `1 playlist`; other counts are left alone. */
export function fixSingularCounts(text: string): string {
  return text.replace(
    /(^|[^\d.,])1 ([A-Za-z]+)/g,
    (_match, prefix: string, word: string) => `${prefix}1 ${singularize(word)}`,
  );
}

function summarizeNamedItems(
  items: unknown[],
  label: string,
  maxItems = 2,
): string | null {
  const names = items
    .map((item) => {
      if (typeof item !== "object" || !item) {
        return null;
      }
      const record = item as Record<string, unknown>;
      for (const field of ["name", "full_name", "title"]) {
        if (typeof record[field] === "string" && record[field]) {
          return record[field] as string;
        }
      }
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, maxItems);

  if (names.length === 0) {
    return null;
  }

  return `${label}: ${names.join(", ")}`;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function compareDatasetOrder(
  left: {
    lastRunAt: string | null;
    name: string | undefined;
    source: string;
  },
  right: {
    lastRunAt: string | null;
    name: string | undefined;
    source: string;
  },
): number {
  const leftTime = left.lastRunAt ? Date.parse(left.lastRunAt) : 0;
  const rightTime = right.lastRunAt ? Date.parse(right.lastRunAt) : 0;
  return (
    rightTime - leftTime ||
    (left.name ?? left.source).localeCompare(
      right.name ?? right.source,
      undefined,
      {
        sensitivity: "base",
      },
    )
  );
}

function compareLogRecordOrder(
  left: {
    source: string;
    lastRunAt: string | null;
  },
  right: {
    source: string;
    lastRunAt: string | null;
  },
): number {
  const leftTimestamp = left.lastRunAt ? Date.parse(left.lastRunAt) : 0;
  const rightTimestamp = right.lastRunAt ? Date.parse(right.lastRunAt) : 0;
  return (
    rightTimestamp - leftTimestamp ||
    left.source.localeCompare(right.source, undefined, {
      sensitivity: "base",
    })
  );
}

export function hasCollectedData(
  dataState: SourceStatus["dataState"] | null | undefined,
): boolean {
  return (
    dataState === "collected_local" ||
    dataState === "ingest_unavailable" ||
    dataState === "ingested_personal_server" ||
    dataState === "ingest_failed"
  );
}

function formatLogOutcomeLabel(
  lastRunOutcome: string | null,
  dataState: SourceStatus["dataState"] | null,
): string {
  if (lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE) {
    return "unavailable";
  }
  if (lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH) {
    return "manual step";
  }
  if (lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    return "error";
  }
  if (lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT) {
    return "needs input";
  }
  if (dataState === "ingested_personal_server") {
    return "synced";
  }
  if (dataState === "ingest_unavailable") {
    return "pending sync";
  }
  if (dataState === "ingest_failed") {
    return "sync failed";
  }
  if (dataState === "collected_local") {
    return "local";
  }
  return "recent";
}

function isAttentionLog(
  lastRunOutcome: string | null,
  dataState: SourceStatus["dataState"] | null,
): boolean {
  return !(
    dataState === "collected_local" ||
    dataState === "ingested_personal_server" ||
    lastRunOutcome === CliOutcomeStatus.CONNECTED_LOCAL_ONLY ||
    lastRunOutcome === CliOutcomeStatus.CONNECTED_AND_INGESTED
  );
}

function toneForLogOutcome(
  lastRunOutcome: string | null,
  dataState: SourceStatus["dataState"] | null,
): RenderTone {
  if (lastRunOutcome === CliOutcomeStatus.RUNTIME_ERROR) {
    return "error";
  }
  if (
    lastRunOutcome === CliOutcomeStatus.CONNECTOR_UNAVAILABLE ||
    lastRunOutcome === CliOutcomeStatus.LEGACY_AUTH ||
    lastRunOutcome === CliOutcomeStatus.NEEDS_INPUT ||
    dataState === "ingest_failed" ||
    dataState === "ingest_unavailable"
  ) {
    return "warning";
  }
  if (dataState === "ingested_personal_server") {
    return "success";
  }
  if (dataState === "collected_local") {
    return "muted";
  }
  return "muted";
}

// ---------------------------------------------------------------------------
// Detach (background process)
// ---------------------------------------------------------------------------

async function runDetached(
  command: string,
  source: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);
  const registrySources = await loadRegistrySources();
  const sourceLabels = createSourceLabelMap(registrySources);
  const displayName = displaySource(source, sourceLabels);

  // Check if source has been previously connected (has a session to reuse).
  // Detach is for re-collection with existing sessions, not first-time auth.
  const state = await readCliState();
  const sourceState = state.sources[source];
  if (!sourceState?.lastResultPath && !sourceState?.sessionPresent) {
    emit.info(
      `Run ${emit.code(`vana connect ${source}`)} first to authenticate.`,
    );
    emit.detail(
      "Use --detach for background re-collection after the first connect.",
    );
    return 1;
  }

  const sessionsDir = getSessionsDir();
  const logsDir = getLogsDir();
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, `${source}-detach.log`);
  const sessionPath = path.join(sessionsDir, `${source}.json`);

  const logFd = fs.openSync(logPath, "a");

  // --no-input: if auth is needed, fail fast and record needs_reauth.
  // Don't use --ipc: nobody is watching a detached process.
  const childArgs = [
    process.argv[1],
    command,
    source,
    "--json",
    "--quiet",
    "--no-input",
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, VANA_DETACHED: "1" },
  });
  trackActiveTelemetryEvent("detached_run_spawned", { source });
  child.unref();
  fs.closeSync(logFd);

  // Write session file
  const session = {
    source,
    command,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    status: "running",
    logPath,
  };
  await fsp.writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(session)}\n`);
    return 0;
  }

  const verb = command === "connect" ? "Connecting" : "Collecting";
  emit.info(`${verb} ${displayName} in the background.`);
  emit.detail(`Check progress: ${emit.code("vana status")}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Schedule commands
// ---------------------------------------------------------------------------

const WINDOWS_TASK_NAME = "VanaScheduledCollection";

function parseIntervalSeconds(interval: string): number {
  const lower = interval.toLowerCase().trim();
  const match = /^(\d+)\s*(h|d|m|w)$/i.exec(lower);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === "h") return value * 3600;
    if (unit === "d") return value * 86400;
    if (unit === "w") return value * 7 * 86400;
    if (unit === "m") return value * 30 * 86400;
  }
  if (lower === "daily") return 86400;
  if (lower === "weekly") return 7 * 86400;
  // Default to 24h
  return 86400;
}

function formatIntervalHuman(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * Everything the schedule commands touch outside this process, so tests run
 * them against a temp plist and a fake launchctl/crontab instead of the real
 * ~/Library/LaunchAgents.
 */
export interface ScheduleDeps {
  platform: NodeJS.Platform;
  /** Absolute path of the launchd plist. */
  plistPath: string;
  /** The env the schedule is created from and compared against. */
  env: Record<string, string | undefined>;
  /** Runs a shell command and returns stdout; throws on a non-zero exit. */
  exec: (command: string, input?: string) => string;
  /** The program argv the scheduler should start. */
  resolveCommand: () => string[];
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  unlink: (filePath: string) => Promise<void>;
}

export function defaultScheduleDeps(): ScheduleDeps {
  return {
    platform: process.platform,
    plistPath: path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    ),
    env: process.env,
    exec: (command, input) =>
      execSync(command, {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    resolveCommand: () => resolveScheduledCommand(),
    readFile: (filePath) => fsp.readFile(filePath, "utf8"),
    writeFile: (filePath, content) => fsp.writeFile(filePath, content),
    mkdir: async (dirPath) => {
      await fsp.mkdir(dirPath, { recursive: true });
    },
    unlink: (filePath) => fsp.unlink(filePath),
  };
}

export class ScheduleTargetUnstableError extends Error {}

/**
 * The argv a scheduler should run, every element an absolute path.
 *
 * launchd, cron and Task Scheduler inherit none of the shell's PATH, so the
 * `vana` on `$PATH` is the wrong answer twice over: under npm it is a shim
 * whose `#!/usr/bin/env node` shebang cannot find a version-managed node,
 * and the scheduler only reports it as `env: node: No such file or
 * directory`. Naming the interpreter and the script outright removes the
 * lookup entirely.
 */
export function resolveScheduledCommand(
  installMethod: CliInstallMethod = getCliInstallMethod(),
  execPath = process.execPath,
  entryScript = process.argv[1],
): string[] {
  // A SEA binary is its own interpreter; there is no script to pass.
  if (installMethod === "homebrew" || installMethod === "installer") {
    return [execPath];
  }
  if (!entryScript || !path.isAbsolute(entryScript)) {
    throw new ScheduleTargetUnstableError(
      "Could not work out which file to schedule.",
    );
  }
  // npx unpacks into a cache npm is free to evict, so a schedule pointing
  // there works until it silently does not.
  if (normalizePathForMatch(entryScript).includes("/_npx/")) {
    throw new ScheduleTargetUnstableError(
      "This CLI is running from an npx cache, which npm may delete at any time.",
    );
  }
  return [execPath, entryScript];
}

/** The installed job as its definition reads, or null when there is none. */
async function readInstalledSchedule(deps: ScheduleDeps): Promise<
  | (InstalledSchedule & {
      mechanism: "launchd" | "cron" | "schtasks";
      definition: string;
    })
  | null
> {
  if (deps.platform === "darwin") {
    try {
      const content = await deps.readFile(deps.plistPath);
      return {
        ...parseLaunchdPlist(content),
        mechanism: "launchd",
        definition: content,
      };
    } catch {
      return null;
    }
  }

  if (deps.platform === "linux") {
    try {
      const vanaLine = deps
        .exec("crontab -l 2>/dev/null")
        .split("\n")
        .find((line) => line.includes(CRONTAB_MARKER));
      if (!vanaLine) return null;
      return {
        ...parseCrontabEntry(vanaLine),
        mechanism: "cron",
        definition: vanaLine,
      };
    } catch {
      return null;
    }
  }

  if (deps.platform === "win32") {
    try {
      const output = deps.exec(
        `schtasks /Query /TN "${WINDOWS_TASK_NAME}" /FO LIST`,
      );
      // The interval is not easily parsed back; 86400 means "present".
      return {
        intervalSeconds: 86400,
        logPath: null,
        env: {},
        mechanism: "schtasks",
        definition: output,
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function getExistingScheduleInterval(): Promise<number | null> {
  const installed = await readInstalledSchedule(defaultScheduleDeps());
  return installed ? (installed.intervalSeconds ?? 86400) : null;
}

/** Plain words for the drift `schedule add` repairs and `list` warns about. */
function describeScheduleDrift(drift: ScheduleDrift): string {
  switch (drift.kind) {
    case "log_outside_home":
      return drift.logPath
        ? `It logs to ${formatDisplayPath(drift.logPath)}, outside the state it collects into (${formatDisplayPath(drift.home)}).`
        : `It keeps no log in the state it collects into (${formatDisplayPath(drift.home)}).`;
    case "home_not_pinned":
      return "It was written by an older CLI that does not pin its state or record its runs.";
    case "other_home":
      return `It collects into ${formatDisplayPath(drift.home)}, not this shell's ${formatDisplayPath(drift.currentHome)}.`;
  }
}

function isRepairableDrift(drift: ScheduleDrift): boolean {
  return drift.kind !== "other_home";
}

/**
 * Install or refresh the scheduled collection. Re-running it is the repair
 * for a job written by an older CLI: the job is rewritten to pin the state
 * of the shell running `add`, with its log inside that state.
 *
 * @param interval - `--every`; when omitted an existing job keeps its own.
 */
export async function runScheduleAdd(
  interval: string | undefined,
  options: GlobalOptions,
  deps: ScheduleDeps = defaultScheduleDeps(),
): Promise<number> {
  const emit = createEmitter(options);
  const target = resolveScheduleTarget(deps.env, options.network);
  const existing = await readInstalledSchedule(deps);
  const intervalSeconds =
    interval !== undefined
      ? parseIntervalSeconds(interval)
      : (existing?.intervalSeconds ?? 86400);
  const intervalLabel = formatIntervalHuman(intervalSeconds);

  let vanaCommand: string[];
  try {
    vanaCommand = deps.resolveCommand();
  } catch (error) {
    if (!(error instanceof ScheduleTargetUnstableError)) {
      throw error;
    }
    emit.info(`Cannot schedule collection. ${error.message}`);
    emit.detail(
      "Install the CLI first (`npm install -g vana-cli`), then run `vana schedule add` from that install.",
    );
    return CliExitCode.FAILURE;
  }

  await deps.mkdir(path.dirname(target.logPath));

  const repaired = existing
    ? diagnoseSchedule(existing, target.home).drift.filter(isRepairableDrift)
    : [];

  let mechanism: "launchd" | "cron" | "schtasks";
  let definition: string;
  if (deps.platform === "darwin") {
    mechanism = "launchd";
    definition = generateLaunchdPlist(vanaCommand, intervalSeconds, target);
  } else if (deps.platform === "linux") {
    // cron doesn't defer missed jobs (unlike launchd), so we run hourly and
    // let isCollectionDue() filter per-source. A missed 2am tick self-heals
    // at 3am instead of waiting 24h.
    mechanism = "cron";
    definition = generateCrontabEntry(vanaCommand, 1, target);
  } else if (deps.platform === "win32") {
    mechanism = "schtasks";
    definition = "";
  } else {
    emit.info(
      "Scheduled collection is not supported on this platform. Run `vana collect --all` manually.",
    );
    return CliExitCode.FAILURE;
  }

  const unchanged =
    existing !== null &&
    existing.mechanism === mechanism &&
    mechanism !== "schtasks" &&
    existing.definition.trim() === definition.trim();
  const action: "added" | "updated" | "repaired" | "unchanged" = unchanged
    ? "unchanged"
    : existing === null
      ? "added"
      : repaired.length > 0
        ? "repaired"
        : "updated";

  if (!unchanged) {
    const installed = await installScheduleDefinition(
      mechanism,
      definition,
      vanaCommand,
      intervalSeconds,
      deps,
    );
    if (!installed.ok) {
      emit.info(installed.message);
      emit.detail(installed.manual);
      return CliExitCode.FAILURE;
    }
  }

  trackActiveTelemetryEvent("schedule_added", {
    metadata: { interval: intervalLabel, mechanism, action },
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        action,
        interval: intervalLabel,
        mechanism,
        ...(mechanism === "launchd" ? { plistPath: deps.plistPath } : {}),
        ...(mechanism === "schtasks"
          ? {}
          : { home: target.home, logPath: target.logPath }),
        repaired: repaired.map((d) => d.kind),
      })}\n`,
    );
    return CliExitCode.OK;
  }

  const every = intervalLabel === "1d" ? "daily" : `every ${intervalLabel}`;
  if (action === "unchanged") {
    emit.info(`The ${every} collection schedule is already up to date.`);
  } else if (action === "repaired") {
    emit.info(`Repaired the ${every} collection schedule.`);
    for (const drift of repaired) {
      emit.detail(`Was: ${describeScheduleDrift(drift)}`);
    }
  } else if (action === "updated") {
    emit.info(`Updated the ${every} collection schedule.`);
  } else {
    emit.info(`Added ${every} collection schedule.`);
  }
  emit.detail(`Runs: ${emit.code("vana collect --all --quiet")}`);
  if (mechanism !== "schtasks") {
    emit.detail(`State: ${formatDisplayPath(target.home)}`);
    emit.detail(`Log: ${formatDisplayPath(target.logPath)}`);
  }
  emit.detail(
    `Managed by: ${mechanism === "schtasks" ? "Task Scheduler" : mechanism}`,
  );
  return CliExitCode.OK;
}

async function installScheduleDefinition(
  mechanism: "launchd" | "cron" | "schtasks",
  definition: string,
  vanaCommand: string[],
  intervalSeconds: number,
  deps: ScheduleDeps,
): Promise<{ ok: true } | { ok: false; message: string; manual: string }> {
  if (mechanism === "launchd") {
    // launchd keeps the job it loaded; a new plist on disk changes nothing
    // until the old one is unloaded and the new one loaded.
    try {
      deps.exec(`launchctl unload "${deps.plistPath}" 2>/dev/null`);
    } catch {
      // Not loaded, that's fine
    }
    await deps.mkdir(path.dirname(deps.plistPath));
    await deps.writeFile(deps.plistPath, definition);
    try {
      deps.exec(`launchctl load "${deps.plistPath}"`);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: "Could not load the launchd plist. Load it manually:",
        manual: `launchctl load "${deps.plistPath}"`,
      };
    }
  }

  if (mechanism === "cron") {
    try {
      let existing = "";
      try {
        existing = deps.exec("crontab -l 2>/dev/null");
      } catch {
        // No existing crontab
      }
      const filtered = existing
        .split("\n")
        .filter((line) => !line.includes(CRONTAB_MARKER))
        .join("\n");
      deps.exec("crontab -", `${filtered.trimEnd()}\n${definition}\n`);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: "Could not update crontab. Add this entry manually:",
        manual: definition,
      };
    }
  }

  const intervalMinutes = Math.max(1, Math.round(intervalSeconds / 60));
  const trCmd = `${vanaCommand.map((arg) => `\\"${arg}\\"`).join(" ")} ${SCHEDULED_COLLECT_ARGS.join(" ")}`;
  try {
    try {
      deps.exec(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F 2>nul`);
    } catch {
      // Not present, that's fine
    }
    if (intervalSeconds >= 86400) {
      deps.exec(
        `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR "${trCmd}" /SC DAILY /ST 09:00 /F`,
      );
    } else {
      deps.exec(
        `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR "${trCmd}" /SC MINUTE /MO ${intervalMinutes} /F`,
      );
    }
    // Enable StartWhenAvailable for deferred execution
    try {
      deps.exec(
        `powershell -Command "$t = Get-ScheduledTask '${WINDOWS_TASK_NAME}'; $t.Settings.StartWhenAvailable = $true; Set-ScheduledTask -InputObject $t"`,
      );
    } catch {
      // Non-fatal if PowerShell cmdlet fails
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Could not create scheduled task. Create it manually:",
      manual: `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR "${trCmd}" /SC DAILY /ST 09:00 /F`,
    };
  }
}

/**
 * Show the installed job: how often, which state it collects into, where it
 * logs, and whether it has drifted from what `schedule add` writes today.
 */
export async function runScheduleList(
  options: GlobalOptions,
  deps: ScheduleDeps = defaultScheduleDeps(),
): Promise<number> {
  const emit = createEmitter(options);
  const installed = await readInstalledSchedule(deps);

  if (!installed) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ scheduled: false })}\n`);
      return CliExitCode.OK;
    }
    emit.info("No scheduled collection found.");
    emit.detail(`Add one with ${emit.code("vana schedule add")}.`);
    return CliExitCode.OK;
  }

  const intervalSeconds = installed.intervalSeconds ?? 86400;
  const intervalLabel = formatIntervalHuman(intervalSeconds);

  if (installed.mechanism === "schtasks") {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          scheduled: true,
          mechanism: "schtasks",
          taskName: WINDOWS_TASK_NAME,
        })}\n`,
      );
      return CliExitCode.OK;
    }
    emit.keyValue("Scheduled collection", "Task Scheduler", "muted");
    const statusLine = installed.definition
      .split("\n")
      .find((l) => l.includes("Status:"));
    if (statusLine) {
      emit.detail(statusLine.trim());
    }
    return CliExitCode.OK;
  }

  const { jobHome, drift } = diagnoseSchedule(
    installed,
    vanaHomeForEnv(deps.env),
  );
  const outdated = drift.some(isRepairableDrift);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        scheduled: true,
        interval: intervalLabel,
        intervalSeconds,
        mechanism: installed.mechanism,
        ...(installed.mechanism === "launchd"
          ? { plistPath: deps.plistPath }
          : { entry: installed.definition }),
        home: jobHome,
        logPath: installed.logPath,
        env: installed.env,
        outdated,
        warnings: drift.map((d) => ({
          kind: d.kind,
          message: describeScheduleDrift(d),
        })),
      })}\n`,
    );
    return CliExitCode.OK;
  }

  emit.keyValue(
    "Scheduled collection",
    `every ${intervalLabel}`,
    outdated ? "warning" : "muted",
  );
  emit.detail(`State: ${formatDisplayPath(jobHome)}`);
  emit.detail(
    `Log: ${installed.logPath ? formatDisplayPath(installed.logPath) : "none"}`,
  );
  emit.detail(
    `Managed by: ${installed.mechanism === "launchd" ? deps.plistPath : "cron"}`,
  );
  for (const d of drift) {
    emit.detail(`Warning: ${describeScheduleDrift(d)}`);
  }
  if (outdated) {
    emit.detail(
      `Repair it with ${emit.code("vana schedule add")}, run from the shell whose state it should collect into.`,
    );
  }
  return CliExitCode.OK;
}

export async function runScheduleRemove(
  options: GlobalOptions,
  deps: ScheduleDeps = defaultScheduleDeps(),
): Promise<number> {
  const emit = createEmitter(options);
  const installed = await readInstalledSchedule(deps);

  let removed = false;
  if (installed?.mechanism === "launchd") {
    try {
      deps.exec(`launchctl unload "${deps.plistPath}"`);
    } catch {
      // Already unloaded
    }
    try {
      await deps.unlink(deps.plistPath);
      removed = true;
    } catch {
      // Gone already
    }
  } else if (installed?.mechanism === "cron") {
    try {
      const filtered = deps
        .exec("crontab -l 2>/dev/null")
        .split("\n")
        .filter((line) => !line.includes(CRONTAB_MARKER))
        .join("\n");
      deps.exec("crontab -", `${filtered.trimEnd()}\n`);
      removed = true;
    } catch {
      // No crontab available
    }
  } else if (installed?.mechanism === "schtasks") {
    try {
      deps.exec(`schtasks /Delete /TN "${WINDOWS_TASK_NAME}" /F`);
      removed = true;
    } catch {
      // Task not found
    }
  }

  if (removed && installed) {
    trackActiveTelemetryEvent("schedule_removed", {
      metadata: { mechanism: installed.mechanism },
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
    return CliExitCode.OK;
  }

  emit.info(
    removed
      ? "Removed the collection schedule."
      : "No scheduled collection found to remove.",
  );
  return CliExitCode.OK;
}

function isPromptCancelled(error: unknown): boolean {
  return (
    isPromptInputClosed(error) ||
    (error instanceof Error &&
      (error.name === "ExitPromptError" || error.message.includes("SIGINT")))
  );
}

// ---------------------------------------------------------------------------
// Skill commands
// ---------------------------------------------------------------------------

const BASE_SKILL_ID = "connect-data";

async function maybePromptSkillInstall(
  emit: ReturnType<typeof createEmitter>,
): Promise<void> {
  try {
    const skills = await listAvailableSkills();
    const baseSkill = skills.find((s) => s.id === BASE_SKILL_ID);
    if (!baseSkill) return;

    const installed = await readInstalledSkills();
    if (installed.some((s) => s.id === BASE_SKILL_ID)) {
      await updateCliConfig({ skillsPromptCompleted: true });
      return;
    }

    emit.blank();
    const shouldInstall = await confirm({
      message:
        "Install a skill so your coding agent knows how to use your connected data?",
      default: true,
      ...vanaPromptTheme,
    });

    if (shouldInstall) {
      try {
        await installSkill(BASE_SKILL_ID);
        emit.success(`Installed skill: ${baseSkill.name}`);
      } catch {
        // Non-fatal.
      }
      const remaining = skills.filter((s) => s.id !== BASE_SKILL_ID);
      if (remaining.length > 0) {
        emit.next("vana skills");
      }
    }

    await updateCliConfig({ skillsPromptCompleted: true });
  } catch {
    // Prompt cancelled or error — mark as completed to avoid re-asking.
    await updateCliConfig({ skillsPromptCompleted: true });
  }
}

async function runSkillsGuidedPicker(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);

  if (options.json) {
    // In JSON mode, fall back to list behavior
    return runSkillList(options);
  }

  if (options.noInput || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runSkillList(options);
  }

  try {
    const skills = await listAvailableSkills();
    const installed = await readInstalledSkills();
    const installedIds = new Set(installed.map((s) => s.id));

    if (skills.length === 0) {
      emit.info("No skills are available right now.");
      return 0;
    }

    const choices = skills.map((skill) => {
      const isInstalled = installedIds.has(skill.id);
      return {
        value: skill.id,
        name: `${skill.name}${isInstalled ? " (installed)" : ""}`,
        description: skill.description,
      };
    });

    const selectedId = await searchSelect({
      message: "Select a skill.",
      choices,
      ...vanaPromptTheme,
    });

    if (installedIds.has(selectedId)) {
      return runSkillShow(selectedId, options);
    }
    return runSkillInstall(selectedId, options);
  } catch (error) {
    if (isPromptCancelled(error)) {
      emit.info("Cancelled.");
      return 1;
    }
    throw error;
  }
}

async function runSkillList(options: GlobalOptions): Promise<number> {
  const emit = createEmitter(options);

  try {
    const skills = await listAvailableSkills();
    const installed = await readInstalledSkills();
    const installedIds = new Set(installed.map((s) => s.id));

    const enriched = skills.map((skill) => ({
      ...skill,
      installed: installedIds.has(skill.id),
    }));

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ count: enriched.length, skills: enriched })}\n`,
      );
      return 0;
    }

    emit.title("Available skills");
    emit.blank();

    if (enriched.length === 0) {
      emit.info("No skills are available right now.");
      return 0;
    }

    for (const skill of enriched) {
      const tag = skill.installed
        ? ` ${emit.badge("installed", "accent")}`
        : "";
      emit.info(`  ${skill.name}${tag}`);
      emit.detail(`  ${skill.description}`);
    }

    const uninstalled = enriched.find((s) => !s.installed);
    if (uninstalled) {
      emit.blank();
      emit.next(`vana skills install ${uninstalled.id}`);
    }

    return 0;
  } catch (error) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } else {
      emit.info(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

async function runSkillInstall(
  name: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);

  try {
    const { installedPath } = await installSkill(name);
    trackActiveTelemetryEvent("skill_installed", {
      metadata: { skillName: name },
    });

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, id: name, installedPath })}\n`,
      );
      return 0;
    }

    emit.success(`Installed ${name}.`);
    emit.blank();
    const skills = await listAvailableSkills();
    const installed = await readInstalledSkills();
    const installedIds = new Set([...installed.map((s) => s.id), name]);
    const nextSkill = skills.find((s) => !installedIds.has(s.id));
    emit.next(
      nextSkill ? `vana skills install ${nextSkill.id}` : "vana skills list",
    );

    return 0;
  } catch (error) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } else {
      emit.info(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

async function runSkillShow(
  name: string,
  options: GlobalOptions,
): Promise<number> {
  const emit = createEmitter(options);

  try {
    const skills = await listAvailableSkills();
    const match = skills.find((s) => s.id.toLowerCase() === name.toLowerCase());

    if (!match) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ error: `No skill found with id "${name}".` })}\n`,
        );
      } else {
        emit.info(`No skill found with id "${name}".`);
        emit.blank();
        emit.next("vana skills list");
      }
      return 1;
    }

    const installed = await readInstalledSkills();
    const isInstalled = installed.some((s) => s.id === match.id);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ...match, installed: isInstalled })}\n`,
      );
      return 0;
    }

    const badges: Array<{ text: string; tone?: RenderTone }> = [];
    if (isInstalled) {
      badges.push({ text: "installed", tone: "success" });
    }
    emit.sourceTitle(match.name, badges);
    emit.detail(match.description);
    emit.keyValue("Version", match.version);

    if (!isInstalled) {
      emit.blank();
      emit.next(`vana skills install ${match.id}`);
    }

    return 0;
  } catch (error) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } else {
      emit.info(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

// ── Login / Logout ─────────────────────────────────────────────────────

/**
 * Trade a browser authorization for a session on a self-hosted Personal
 * Server, then persist it alongside whatever account session already exists.
 */
async function loginToPersonalServer(
  psUrl: string,
  options: GlobalOptions,
): Promise<number> {
  const renderer =
    !options.json && !options.quiet ? createLoginRenderer() : null;
  const humanRenderer = createHumanRenderer();
  renderer?.title(psUrl);

  try {
    const result = await runSelfHostedLoginFlow(psUrl, (url: string) => {
      if (!options.json && !options.quiet) {
        // Same emphasis rule as the cloud flow: the actionable URL
        // carries the Vana accent, the label stays muted.
        process.stderr.write(
          `  ${humanRenderer.theme.muted("Open")}  ${humanRenderer.theme.accent(url)}\n`,
        );
      }
      renderer?.scopeActive("Waiting for authorization");
      // Try to open browser — use spawn with args array to prevent shell injection
      // (a malicious self-hosted PS could return a URL with shell metacharacters).
      // Interactive terminals only: agents, CI and the test suite must never
      // pop a browser (a vitest run used to open the fixture URL for real).
      const browserAllowed =
        Boolean(process.stdout.isTTY) &&
        !options.json &&
        !options.noInput &&
        !process.env.VANA_NO_BROWSER;
      if (browserAllowed) {
        try {
          const { spawn } = require("node:child_process");
          const opener =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
        } catch {
          // Browser open failed — user will open manually
        }
      }
    });

    const liveAccount = accountSessionToPreserve(loadCredentials()?.account);

    await saveCredentials({
      account: liveAccount ?? {
        address: result.address,
        session_token: "",
        expires_at: result.expires_at,
      },
      personal_server: {
        url: psUrl,
        session_token: result.session_token,
        expires_at: result.expires_at,
      },
    });
    await updateCliConfig({ personalServerUrl: psUrl });

    renderer?.success(`Logged in to ${psUrl}`);
    renderer?.detail("Credentials saved to ~/.vana/auth.json");
    if (
      liveAccount &&
      liveAccount.address.toLowerCase() !== result.address.toLowerCase()
    ) {
      renderer?.detail(
        `This server belongs to ${formatAddress(result.address)}; you stay signed in as ${formatAddress(liveAccount.address)}.`,
      );
    }
    return 0;
  } catch (err) {
    renderer?.fail("Login failed");
    renderer?.detail(err instanceof Error ? err.message : String(err));
    renderer?.next(`vana login --server ${psUrl}`);
    return 1;
  } finally {
    renderer?.cleanup();
  }
}

async function runLogin(
  options: GlobalOptions,
  serverUrl?: string,
  clientId?: string,
): Promise<number> {
  // Determine auth target: cloud (account.vana.org) or self-hosted (PS directly)
  const psUrl = serverUrl ?? resolveLoginServerUrl() ?? null;
  const authTarget = getAuthTarget(psUrl);

  // If self-hosted, use /auth/device flow against the PS
  if (authTarget === "self-hosted" && psUrl) {
    return loginToPersonalServer(psUrl, options);
  }

  // Cloud flow (account.vana.org)
  // Check env var shortcut
  const envToken = process.env.VANA_SESSION_TOKEN;
  if (envToken) {
    const creds = loadCredentials();
    if (creds) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ status: "authenticated", source: "env", address: creds.account.address })}\n`,
        );
      } else {
        const emit = createEmitter(options);
        emit.success(`Already authenticated via VANA_SESSION_TOKEN env var`);
      }
      return 0;
    }
  }

  // Check if already logged in
  const existing = loadCredentials();
  // For the account-switch check below: the previous auth file content even
  // when the stored credentials have expired (loadCredentials hides those).
  const previousAuth = readStoredAuthFile();
  if (existing && !isExpired(existing)) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          status: "authenticated",
          address: existing.account.address,
          personal_server: await describeLoginPersonalServer(
            existing.personal_server,
          ),
          expires_at: existing.account.expires_at,
        })}\n`,
      );
    } else {
      const emit = createEmitter(options);
      emit.success(
        `Already logged in as ${formatAddress(existing.account.address)}`,
      );
      const server = await describeLoginPersonalServer(
        existing.personal_server,
      );

      if (server) {
        emit.keyValue(
          "Personal Server",
          server.authenticated
            ? server.url
            : `${server.url} (no session; run \`vana login --server ${server.url}\` to read it)`,
          server.authenticated ? "success" : "warning",
        );
      }
      emit.info(
        `  Auth expires in ${formatExpiresIn(existing.account.expires_at)}`,
      );
      emit.blank();
      emit.info("  Run `vana logout` to sign in as someone else.");
      return (await finishServerSetup(existing.account.address, options)) ?? 0;
    }
    return 0;
  }

  if (options.json) {
    // JSON mode: run flow and output result
    const creds = await runDeviceCodeFlow(
      {
        onCode: (code, uri) => {
          process.stderr.write(
            JSON.stringify({ event: "device_code", code, uri }) + "\n",
          );
        },
        onWaiting: () => {},
        onAuthorized: () => {},
        onExpired: () => {
          process.stdout.write(
            JSON.stringify({
              status: "expired",
              error: "Device code expired",
            }) + "\n",
          );
        },
        onError: (err) => {
          process.stdout.write(
            JSON.stringify({ status: "error", error: err.message }) + "\n",
          );
        },
      },
      { clientId, openBrowser: false },
    );

    if (creds) {
      const settled = await settleCloudLogin(creds, previousAuth);
      const runningServer = await detectRunningServer();
      process.stdout.write(
        `${JSON.stringify({
          status: "authenticated",
          address: creds.account.address,
          personal_server: await describeLoginPersonalServer(
            creds.personal_server,
          ),
          expires_at: creds.account.expires_at,
          ...(settled.restoredSession
            ? { personal_server_restored: true }
            : {}),
          ...(settled.accountSwitch
            ? {
                account_switch: describeAccountSwitch(
                  settled.accountSwitch,
                  runningServer,
                  creds.account.address,
                ),
              }
            : {}),
        })}\n`,
      );
      return 0;
    }
    return 1;
  }

  // Interactive mode
  const renderer = createLoginRenderer();
  const humanRenderer = createHumanRenderer();
  // Branding lives in emphasis, not chrome (CLI-BEAUTY doctrine: no
  // banners). The two things the user must act on - the URL and the code -
  // carry the Vana accent; everything around them stays muted.
  const writeDeviceCodePrompt = (code: string, uri: string) => {
    if (options.json || options.quiet) {
      return;
    }
    const theme = humanRenderer.theme;
    process.stderr.write(`  ${theme.muted("Open")}  ${theme.accent(uri)}\n`);
    process.stderr.write(`  ${theme.muted("Enter")} ${theme.heading(code)}\n`);
  };
  renderer.title("Vana");
  // Set once authorized: a running server that belongs to another account.
  let foreignServer: { url: string; owner: string } | null = null;

  const creds = await runDeviceCodeFlow(
    {
      onCode: (code, uri) => {
        writeDeviceCodePrompt(code, uri);
      },
      onWaiting: () => {
        renderer.scopeActive("Waiting for authorization");
      },
      onAuthorized: async (authedCreds) => {
        const address = authedCreds.account.address;
        const settled = await settleCloudLogin(authedCreds, previousAuth);
        const runningServer = await detectRunningServer();
        const ownServer =
          runningServer && sameAccountAddress(runningServer.owner, address)
            ? runningServer.url
            : null;
        foreignServer =
          !authedCreds.personal_server && runningServer?.owner && !ownServer
            ? { url: runningServer.url, owner: runningServer.owner }
            : null;
        renderer.success(`Logged in as ${formatAddress(address)}`);
        if (settled.accountSwitch) {
          const previous = formatAddress(settled.accountSwitch.previousAddress);
          renderer.detail(
            `This is a different account than the one signed in before (${previous}).`,
          );
          if (settled.accountSwitch.previousSessionKept) {
            renderer.detail(
              `${previous}'s Personal Server session is kept and comes back when you log in as ${previous} again.`,
            );
          }
        }
        if (authedCreds.personal_server) {
          renderer.detail(
            `Personal Server: ${authedCreds.personal_server.url}${settled.restoredSession ? " (session restored)" : ""}`,
          );
        } else if (ownServer) {
          renderer.detail(`Personal Server: ${ownServer} (running)`);
        } else if (foreignServer) {
          renderer.detail(
            `The Personal Server running at ${foreignServer.url} belongs to ${formatAddress(foreignServer.owner)}, not to this account.`,
          );
          renderer.detail(
            `To use it, switch back: sign out at ${getAccountUrl()}, then run \`vana logout\` and \`vana login\` as ${formatAddress(foreignServer.owner)}.`,
          );
          renderer.detail(
            "To run a separate Personal Server for this account instead: vana server start",
          );
        } else {
          renderer.detail("No Personal Server found for this account yet.");
          renderer.next("vana server start");
          renderer.detail(
            "Or point at one you already run: vana server set-url <url>",
          );
        }
        renderer.detail("Credentials saved to ~/.vana/auth.json");
      },
      onExpired: () => {
        renderer.fail("Authorization expired");
        renderer.next("vana login");
      },
      onError: (err) => {
        renderer.fail("Login failed");
        renderer.detail(err.message);
        renderer.next("vana login");
      },
    },
    {
      clientId,
      openBrowser: Boolean(process.stdout.isTTY) && !options.noInput,
    },
  );

  renderer.cleanup();

  if (!creds) return 1;
  // Never offer to start a second server next to another account's without
  // the user reading why: the lines above already said what to do.
  if (foreignServer) return 0;
  return (await finishServerSetup(creds.account.address, options)) ?? 0;
}

interface AccountSwitch {
  previousAddress: string;
  /** The previous account's Personal Server session was parked for later. */
  previousSessionKept: boolean;
}

/**
 * Save a cloud login's credentials. The cloud flow cannot mint Personal
 * Server sessions, so a same-account re-login keeps the stored one, and an
 * account switch parks the previous account's session and restores the new
 * account's own parked one, if it has one.
 */
async function settleCloudLogin(
  creds: VanaCredentials,
  previousAuth: ReturnType<typeof readStoredAuthFile>,
): Promise<{ accountSwitch: AccountSwitch | null; restoredSession: boolean }> {
  const previousAddress = previousAuth?.address ?? null;
  const switched =
    previousAddress !== null &&
    !sameAccountAddress(previousAddress, creds.account.address);
  let previousSessionKept = false;
  if (switched) {
    // Best effort: failing to park it loses no more than login used to.
    previousSessionKept = await stashPersonalServerSession(
      previousAddress,
      previousAuth?.personalServer ?? null,
    ).catch(() => false);
  }
  let restoredSession = false;
  if (!creds.personal_server) {
    if (!switched && previousAuth?.personalServer) {
      creds.personal_server = previousAuth.personalServer;
    } else {
      const stashed = await takeStashedPersonalServerSession(
        creds.account.address,
      ).catch(() => null);
      if (stashed) {
        creds.personal_server = stashed;
        restoredSession = true;
      }
    }
  }
  await saveCredentials(creds);
  // Always sync the pinned PS config to this login's result, including
  // clearing it when this account has no PS, so a stale PS URL from a
  // previously logged-in account can't linger and be used by mistake.
  if (creds.personal_server?.url) {
    await updateCliConfig({ personalServerUrl: creds.personal_server.url });
  } else if (switched) {
    // A different account logged in: its pinned Personal Server URL is
    // stale. Same-account logins keep the pin - the prod token flow
    // carries no PS info, so its absence proves nothing.
    await updateCliConfig({ personalServerUrl: undefined });
  }
  return {
    accountSwitch: switched ? { previousAddress, previousSessionKept } : null,
    restoredSession,
  };
}

/** The Personal Server answering on this machine and its owner, if any. */
async function detectRunningServer(): Promise<{
  url: string;
  owner: string | null;
} | null> {
  try {
    const target = await detectPersonalServerTarget();
    return target.state === "available" && target.url
      ? { url: target.url, owner: target.health?.owner ?? null }
      : null;
  } catch {
    return null;
  }
}

/** The `account_switch` block of a JSON login outcome. */
function describeAccountSwitch(
  accountSwitch: AccountSwitch,
  runningServer: { url: string; owner: string | null } | null,
  address: string,
): Record<string, unknown> {
  const foreign =
    runningServer?.owner && !sameAccountAddress(runningServer.owner, address)
      ? runningServer
      : null;
  return {
    previous_address: accountSwitch.previousAddress,
    previous_personal_server_kept: accountSwitch.previousSessionKept,
    running_server: foreign ? { url: foreign.url, owner: foreign.owner } : null,
    switch_back: `Sign out at ${getAccountUrl()}, then run \`vana logout\` and \`vana login\`.`,
  };
}

function serverStartIo(options: GlobalOptions): ServerStartIo {
  return {
    progress: createProgressHandle({
      enabled: !options.json && !options.quiet,
    }),
    say: (line) => {
      if (!options.json) process.stderr.write(`${line}\n`);
    },
    event: (event) => {
      if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
    },
    confirm: (message) =>
      confirm({ message, default: true, ...vanaPromptTheme }),
  };
}

/** The URL of a running Personal Server this account owns, if any. */
async function findOwnRunningServer(address: string): Promise<string | null> {
  try {
    const target = await detectPersonalServerTarget();
    return target.state === "available" &&
      target.url &&
      target.health?.owner &&
      !personalServerOwnerMismatch(target.health.owner, address)
      ? target.url
      : null;
  } catch {
    return null;
  }
}

/**
 * The last step of a login at a terminal: make this account's Personal
 * Server ready to take `connect` writes. A running server of this account
 * that has not approved the CLI yet (Vana Desktop's, typically) gets that
 * one-time approval now; with none running, offer to start one. Returns an
 * exit code when it ran the server approval, else null.
 */
async function finishServerSetup(
  address: string,
  options: GlobalOptions,
): Promise<number | null> {
  if (
    options.json ||
    options.noInput ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return null;
  }
  const running = await findOwnRunningServer(address);
  if (running) {
    const saved = loadPersonalServerSession();
    const approved = Boolean(
      saved?.session_token && urlsMatch(saved.url, running),
    );
    if (approved || getAuthTarget(running) !== "self-hosted") return null;
    process.stderr.write(
      `\n  Your Personal Server at ${running} needs to approve this CLI once.\n`,
    );
    return loginToPersonalServer(running, options);
  }
  await offerServerStart(address, options);
  return null;
}

/**
 * After a login at a terminal: offer to start this account's Personal Server
 * in the background when none of its servers is running. Asked, never done
 * silently; scripts and --no-input never see it.
 */
async function offerServerStart(
  address: string,
  options: GlobalOptions,
): Promise<void> {
  if (
    options.json ||
    options.noInput ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return;
  }
  const running = await findRunningServers();
  if (
    running.some(
      (server) => server.owner?.toLowerCase() === address.toLowerCase(),
    )
  ) {
    return;
  }
  const start = await confirm({
    message: "Start your Personal Server now? It runs in the background.",
    default: true,
    ...vanaPromptTheme,
  });
  if (!start) {
    process.stderr.write("  Start it later with `vana server start`.\n");
    return;
  }
  await runServerStart(
    {
      network: resolveNetwork(options.network).name,
      detach: true,
      yes: options.yes,
    },
    serverStartIo(options),
  );
}

async function runLogout(options: GlobalOptions): Promise<number> {
  // Revoke the token server-side before clearing local credentials. The PS
  // session can outlive the Account login, so look it up on its own.
  const psSession = loadPersonalServerSession();
  if (psSession?.url && psSession.session_token) {
    try {
      await fetch(`${psSession.url.replace(/\/$/, "")}/auth/device/token`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${psSession.session_token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best-effort — server may be down, but we still clear local creds
    }
  }

  await clearCredentials();

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ status: "logged_out" })}\n`);
  } else {
    const emit = createEmitter(options);
    emit.success("Logged out. Credentials removed.");
  }
  return 0;
}
