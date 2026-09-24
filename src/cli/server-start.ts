import { CliExitCode } from "../core/exit-codes.js";
import type { VanaNetworkName } from "../core/network.js";
import { getTimestampedLogPath } from "../core/paths.js";
import { ensureParentDir } from "../core/index.js";
import {
  canInstallNodeFor,
  findCompatibleNode,
  installManagedNode,
  type ResolvedNode,
} from "../pdpp/host.js";
import {
  isRuntimeInstalled,
  ensureRuntime,
} from "../personal-server/local/runtime.js";
import {
  runOwnerBindingExchange,
  type OwnerBinding,
} from "../personal-server/local/owner-binding.js";
import {
  defaultOwnerSecretStore,
  ownerSecretKey,
  type OwnerSecretStore,
} from "../personal-server/local/owner-secret.js";
import {
  choosePort,
  findRunningServers,
  startLocalServer,
  type LocalServerHandle,
  type RunningServer,
} from "../personal-server/local/server.js";
import {
  getAccountUrl,
  isExpired,
  loadCredentials,
  openBrowser,
  saveCredentials,
  type VanaCredentials,
} from "./auth.js";

/** The server release needs the same Node range as the published connectors. */
const NODE_RANGE = ">=24.15.0 <25";

export interface ServerStartIo {
  /** A line for a person; silent in --json mode. */
  say(line: string): void;
  /** One machine-readable state change; only in --json mode. */
  event(event: Record<string, unknown>): void;
  /** Ask before a one-time install; never called with --no-input or --yes. */
  confirm(message: string): Promise<boolean>;
}

export interface ServerStartDeps {
  findRunningServers: (fetchImpl?: typeof fetch) => Promise<RunningServer[]>;
  loadCredentials: () => VanaCredentials | null;
  saveCredentials: (credentials: VanaCredentials) => Promise<void>;
  secrets: OwnerSecretStore;
  exchange: typeof runOwnerBindingExchange;
  openBrowser: (url: string) => void;
  findNode: (range: string) => Promise<ResolvedNode | null>;
  installNode: (logPath: string) => Promise<ResolvedNode>;
  runtimeInstalled: () => boolean;
  ensureRuntime: (node: ResolvedNode, logPath: string) => Promise<string>;
  choosePort: (requested?: number) => Promise<number | null>;
  start: typeof startLocalServer;
  /** Resolves when the person asks the server to stop (Ctrl+C). */
  waitForStop: (handle: LocalServerHandle) => Promise<"stopped" | "exited">;
}

export function defaultServerStartDeps(): ServerStartDeps {
  return {
    findRunningServers,
    loadCredentials,
    saveCredentials,
    secrets: defaultOwnerSecretStore(),
    exchange: runOwnerBindingExchange,
    openBrowser,
    findNode: findCompatibleNode,
    installNode: installManagedNode,
    runtimeInstalled: () => isRuntimeInstalled(),
    ensureRuntime: (node, logPath) => ensureRuntime(node, logPath),
    choosePort,
    start: startLocalServer,
    waitForStop: (handle) =>
      new Promise((resolve) => {
        // Stay subscribed until the process ends: a second Ctrl+C while the
        // server shuts down must not kill the CLI before it cleans up.
        const onSignal = () => resolve("stopped");
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        void handle.exited.then(() => resolve("exited"));
      }),
  };
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * `vana server start`: run a Personal Server owned by the signed-in account,
 * in the foreground, when no server of theirs is already running.
 */
export async function runServerStart(
  options: {
    network: VanaNetworkName;
    port?: number;
    noInput?: boolean;
    yes?: boolean;
  },
  io: ServerStartIo,
  deps: ServerStartDeps = defaultServerStartDeps(),
): Promise<number> {
  const credentials = deps.loadCredentials();
  const account = credentials?.account;
  const signedIn = Boolean(
    credentials && account?.session_token && !isExpired(credentials),
  );

  if (!signedIn || !credentials || !account) {
    io.say(
      "Run `vana login` first: the server belongs to the account you sign in with.",
    );
    io.event({ type: "server-needs-login" });
    return CliExitCode.CONFIRMATION_REQUIRED;
  }

  // One server per owner. If this account already has one (Desktop's, or an
  // earlier `vana server start`), use it. Another identity's server can run
  // beside ours: separate data dirs, and `vana connect` picks the one this
  // account owns.
  const running = await deps.findRunningServers();
  const ours = running.find(
    (server) => server.owner?.toLowerCase() === account.address.toLowerCase(),
  );
  if (ours) {
    io.say(
      `Your Personal Server is already running at ${ours.url}. Nothing to start.`,
    );
    io.event({
      type: "server-already-running",
      url: ours.url,
      owner: ours.owner,
    });
    return CliExitCode.OK;
  }
  for (const other of running) {
    io.say(
      other.owner
        ? `${other.url} runs a Personal Server for ${other.owner}; yours will use another port.`
        : `Something else answers at ${other.url}; yours will use another port.`,
    );
  }

  const logPath = getTimestampedLogPath("server-start");
  await ensureParentDir(logPath);

  // Owner binding: once per account, then from the keychain.
  const accountUrl = getAccountUrl();
  const secretKey = ownerSecretKey(accountUrl, account.address);
  let binding: OwnerBinding | null = deps.secrets.get(secretKey);
  if (!binding) {
    if (options.noInput) {
      io.say(
        "The first start needs you to confirm in a browser. Run it without --no-input.",
      );
      io.event({ type: "server-needs-owner-confirmation" });
      return CliExitCode.CONFIRMATION_REQUIRED;
    }
    io.say("Confirm in your browser that this Personal Server is yours.");
    try {
      binding = await deps.exchange(
        { accountUrl, accessToken: account.session_token },
        {
          openBrowser: deps.openBrowser,
          onConfirmationUrl: (url) =>
            io.say(`If the browser did not open: ${url}`),
        },
      );
    } catch (error) {
      io.say(error instanceof Error ? error.message : String(error));
      io.event({ type: "server-owner-confirmation-failed" });
      return CliExitCode.FAILURE;
    }
    if (
      isAddress(account.address) &&
      binding.signerAddress.toLowerCase() !== account.address.toLowerCase()
    ) {
      io.say(
        `The confirmation came back signed by ${binding.signerAddress}, not ${account.address}. Nothing was saved.`,
      );
      return CliExitCode.FAILURE;
    }
    deps.secrets.set(secretKey, binding);
  }

  // One-time installs: Node 24 and the pinned server.
  let node = await deps.findNode(NODE_RANGE);
  const runtimeReady = deps.runtimeInstalled();
  if (!node || !runtimeReady) {
    const needs = [
      ...(node ? [] : ["Node.js 24, which the server runs on"]),
      ...(runtimeReady ? [] : ["the Personal Server itself (~175 MB)"]),
    ];
    if (options.noInput && !options.yes) {
      io.say(
        `The first start installs ${needs.join(" and ")}. Run without --no-input, or add --yes.`,
      );
      io.event({ type: "server-setup-required", needs });
      return CliExitCode.NOT_READY;
    }
    if (
      !options.yes &&
      !(await io.confirm(`Install ${needs.join(" and ")} under ~/.vana?`))
    ) {
      io.say("Cancelled.");
      return CliExitCode.FAILURE;
    }
    if (!node) {
      if (!canInstallNodeFor(NODE_RANGE)) {
        io.say(
          `This machine needs Node ${NODE_RANGE}; install it and set VANA_PDPP_NODE.`,
        );
        return CliExitCode.NOT_READY;
      }
      io.say("Installing Node.js...");
      node = await deps.installNode(logPath);
    }
  }
  if (!runtimeReady) io.say("Installing the Personal Server (one time)...");
  const runtimeDir = await deps.ensureRuntime(node, logPath);

  const port = await deps.choosePort(options.port);
  if (!port) {
    io.say(
      options.port
        ? `Port ${options.port} or ${options.port + 1} is taken.`
        : "Ports 8080 to 8085 are taken; pass --port.",
    );
    return CliExitCode.FAILURE;
  }

  let handle: LocalServerHandle;
  try {
    handle = await deps.start({
      network: options.network,
      node,
      runtimeDir,
      binding,
      port,
      logPath,
    });
  } catch (error) {
    io.say(error instanceof Error ? error.message : String(error));
    io.event({ type: "server-failed", logPath });
    return CliExitCode.FAILURE;
  }

  // `vana connect` finds the server by port scan; this token lets it write.
  const url = `http://localhost:${handle.port}`;
  await deps.saveCredentials({
    ...credentials,
    personal_server: {
      url,
      session_token: handle.accessToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  io.say(`Personal Server running at ${url}`);
  io.say(`Owner ${binding.signerAddress}, network ${options.network}.`);
  io.say(
    "Local only: not registered and not reachable from other devices yet.",
  );
  io.say("Collect into it with `vana connect <source>`. Press Ctrl+C to stop.");
  io.event({
    type: "server-ready",
    url,
    owner: binding.signerAddress,
    network: options.network,
    registered: false,
    logPath,
  });

  const reason = await deps.waitForStop(handle);
  await handle.stop();
  if (reason === "exited") {
    io.say(`The Personal Server stopped unexpectedly. See ${logPath}.`);
    io.event({ type: "server-exited", logPath });
    return CliExitCode.FAILURE;
  }
  io.say("Stopped.");
  io.event({ type: "server-stopped" });
  return CliExitCode.OK;
}
