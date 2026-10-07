import fs from "node:fs";
import path from "node:path";

import { CliExitCode } from "../core/exit-codes.js";
import type { ProgressHandle } from "./render/progress.js";
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
  NpmMissingError,
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
  acquireDataDirLock,
  choosePort,
  findRunningServers,
  nextMessage,
  readPublicMarker,
  startLocalServer,
  writePublicMarker,
  type LocalServerHandle,
  type PublicMarker,
  type RunningServer,
  type ServerMessage,
} from "../personal-server/local/server.js";
import {
  startDetachedServer,
  type DetachedStart,
} from "../personal-server/local/detach.js";
import {
  resolveServerDataDir,
  runningCliServers,
  serverPidIn,
  type DataDirResolution,
} from "../personal-server/local/data-dir.js";
import {
  installFrpc,
  resolveFrpc,
  type FrpcResolution,
} from "../personal-server/local/frpc.js";
import {
  RegistrationNeedsBrowserError,
  signServerRegistration,
  type RegistrationRequest,
} from "../personal-server/local/registration.js";
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
  /** A spinner line for waits; absent (or a no-op) outside a terminal. */
  progress?: ProgressHandle;
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
  resolveFrpc: () => Promise<FrpcResolution>;
  installFrpc: (logPath: string) => Promise<string>;
  signRegistration: typeof signServerRegistration;
  readPublicMarker: (dataDir: string) => PublicMarker | null;
  writePublicMarker: (dataDir: string, marker: PublicMarker) => Promise<void>;
  /** The owner's own data dir, moved there from an older layout if needed. */
  resolveDataDir: (
    network: VanaNetworkName,
    owner: string,
    running: RunningServer[],
  ) => Promise<DataDirResolution>;
  /** The pid of a vana-started server running from a data dir. */
  serverPidIn: (dataDir: string) => number | null;
  startDetached: typeof startDetachedServer;
  /**
   * Whether the running server, if it is the one this CLI runs for the
   * network, charges builder reads: false when an older CLI started it
   * without payment in its config, null when that cannot be told.
   */
  runningServerCharges: (
    network: VanaNetworkName,
    identity: string | null,
  ) => boolean | null;
  /**
   * Resolves when the person asks the server to stop: Ctrl+C, or the SIGTERM
   * `vana server stop` sends. Called once per start, before the server runs.
   */
  stopRequested: () => Promise<void>;
  /** Claim the data dir for the life of this process (acquireDataDirLock). */
  lockDataDir: (dataDir: string) => Promise<() => Promise<void>>;
  /** Waits between restarts of a server that exited on its own. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Waits before each restart of a server that exited on its own. A server
 * that crashes again within {@link STABLE_RUN_MS} of starting counts as one
 * more rapid failure; once the waits run out the supervisor gives up.
 */
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** A server that ran this long before exiting starts the count over. */
export const STABLE_RUN_MS = 60_000;

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
    resolveFrpc: () => resolveFrpc(),
    installFrpc: (logPath) => installFrpc(logPath),
    signRegistration: signServerRegistration,
    readPublicMarker,
    writePublicMarker,
    resolveDataDir: resolveServerDataDir,
    serverPidIn,
    startDetached: startDetachedServer,
    runningServerCharges,
    stopRequested: () =>
      new Promise((resolve) => {
        // Stay subscribed until the process ends: a second Ctrl+C while the
        // server shuts down, or restarts, must not kill the CLI before it
        // cleans up.
        const onSignal = () => resolve();
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }),
    lockDataDir: acquireDataDirLock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True or false only for the server this CLI runs for the network, matched
 * by the key address its health reports; null for Desktop's server or when
 * the config cannot be read, since neither proves payment is off.
 */
export function runningServerCharges(
  network: VanaNetworkName,
  identity: string | null,
): boolean | null {
  if (!identity) return null;
  const ours = runningCliServers(network).find(
    (server) => server.identity?.toLowerCase() === identity.toLowerCase(),
  );
  if (!ours) return null;
  const config = readJson(path.join(ours.dir, "server.json"));
  if (!config) return null;
  const payment = config.payment as { enabled?: unknown } | undefined;
  return payment?.enabled === true;
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
    /** Stay local: no tunnel, no registration, nothing apps can reach. */
    local?: boolean;
    /** Start in the background and return once it answers. */
    detach?: boolean;
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
    // A server an earlier CLI started keeps its old config until it restarts,
    // and before payment was part of it, builder reads were served for free.
    const charges = deps.runningServerCharges(
      options.network,
      ours.identity ?? null,
    );
    io.say(
      `Your Personal Server is already running at ${ours.url}. Nothing to start.`,
    );
    if (charges === false) {
      io.say(
        "It was started by an earlier vana and serves apps' reads without charging them. Restart it to apply: vana server stop, then vana server start.",
      );
    }
    io.event({
      type: "server-already-running",
      url: ours.url,
      owner: ours.owner,
      ...(charges === false
        ? {
            restartRequired: true,
            remedy: "vana server stop && vana server start",
          }
        : {}),
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

  // Each owner's server runs from its own data dir. Settle which one, and
  // whether a server already runs from it, before anyone confirms anything.
  const prepareDataDir = async (owner: string): Promise<string | number> => {
    const resolved = await deps.resolveDataDir(options.network, owner, running);
    if (resolved.kind === "unknown-owner") {
      const message = `${resolved.legacyDir} holds a Personal Server an earlier vana started, and nothing on this machine says which account owns it. Move its files into ${path.dirname(resolved.dir)}/<owner address>/ (yours: ${resolved.dir}), then run vana server start again.`;
      io.say(message);
      io.event({
        type: "server-failed",
        reason: "data-dir-owner-unknown",
        message,
        dataDir: resolved.legacyDir,
      });
      return CliExitCode.FAILURE;
    }
    const pid = deps.serverPidIn(resolved.dir);
    if (pid) {
      const message = `A Personal Server started by vana is already running from ${resolved.dir} (pid ${pid}), but it does not answer as yours. Stop it with \`vana server stop\`, then start it again.`;
      io.say(message);
      io.event({
        type: "server-failed",
        reason: "already-running",
        message,
        dataDir: resolved.dir,
        pid,
      });
      return CliExitCode.FAILURE;
    }
    if (resolved.movedFrom) {
      io.say(
        `Moved your server's data from ${resolved.movedFrom} to ${resolved.dir}.`,
      );
      io.event({
        type: "server-data-moved",
        from: resolved.movedFrom,
        to: resolved.dir,
      });
    }
    return resolved.dir;
  };

  // Owner binding: once per account, then from the keychain.
  const accountUrl = getAccountUrl();
  const secretKey = ownerSecretKey(accountUrl, account.address);
  let binding: OwnerBinding | null = deps.secrets.get(secretKey);
  // A session from VANA_SESSION_TOKEN names no address: then the owner is
  // known once the binding is.
  let dataDir: string | null = null;
  const knownOwner = isAddress(account.address)
    ? account.address
    : (binding?.signerAddress ?? null);
  if (knownOwner) {
    const prepared = await prepareDataDir(knownOwner);
    if (typeof prepared === "number") return prepared;
    dataDir = prepared;
  }
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
  if (!dataDir) {
    const prepared = await prepareDataDir(binding.signerAddress);
    if (typeof prepared === "number") return prepared;
    dataDir = prepared;
  }

  // Public unless asked to stay local, as Desktop's server is. A registered
  // server started --local stays registered, and apps find it offline.
  const marker = deps.readPublicMarker(dataDir);
  let frpc: FrpcResolution | null = null;
  if (options.local) {
    if (marker) {
      io.say(
        "This server is registered; while it runs local only, apps find it offline.",
      );
    }
  } else {
    frpc = await deps.resolveFrpc();
    if (frpc.kind === "unavailable") {
      io.say(`${frpc.reason} The server starts local only.`);
      io.event({ type: "server-tunnel-unavailable", reason: frpc.reason });
    }
  }

  // One-time installs: Node 24, the pinned server, the tunnel client.
  let node = await deps.findNode(NODE_RANGE);
  const runtimeReady = deps.runtimeInstalled();
  const frpcNeeded = frpc?.kind === "installable";
  if (!node || !runtimeReady || frpcNeeded) {
    const needs = [
      ...(node ? [] : ["Node.js 24, which the server runs on"]),
      ...(runtimeReady ? [] : ["the Personal Server itself (~175 MB)"]),
      ...(frpcNeeded ? ["the tunnel client, frpc (~15 MB)"] : []),
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
  let runtimeDir: string;
  try {
    runtimeDir = await deps.ensureRuntime(node, logPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const npmMissing = error instanceof NpmMissingError;
    io.say(message);
    io.event({
      type: "server-failed",
      reason: npmMissing ? "npm-missing" : "runtime-install-failed",
      message,
      logPath,
    });
    // A missing npm is this machine's setup, which a person fixes; anything
    // else is the install failing.
    return npmMissing ? CliExitCode.NOT_READY : CliExitCode.FAILURE;
  }
  let frpcPath: string | null = frpc?.kind === "ready" ? frpc.path : null;
  if (frpcNeeded) {
    io.say("Installing the tunnel client (one time)...");
    frpcPath = await deps.installFrpc(logPath);
  }

  // Everything that needed a person is done: the rest runs in the
  // background, as a second `vana server start` that outlives this one.
  if (options.detach) {
    io.say(
      "Starting in the background. The first start takes up to a minute...",
    );
    return reportDetached(
      await startInBackground({ ...options, dataDir }, io, deps),
      io,
    );
  }

  // Hold the data dir for as long as this process supervises it, restarts
  // included: `vana server stop` finds the server by this lock.
  const ownDir = dataDir;
  let releaseDataDir: () => Promise<void>;
  try {
    releaseDataDir = await deps.lockDataDir(ownDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.say(message);
    io.event({
      type: "server-failed",
      reason: "already-running",
      message,
      dataDir: ownDir,
    });
    return CliExitCode.FAILURE;
  }
  const supervise = async (dataDir: string): Promise<number> => {
    // Listen for a stop from here on: one that comes while the server is
    // starting or restarting must still stop it, and never restart it.
    let stopping = false;
    const stopped = deps.stopRequested().then(() => {
      stopping = true;
      return "stopped" as const;
    });
    const appendLog = (line: string) =>
      fs.promises
        .appendFile(logPath, `[vana] ${line}\n`, { mode: 0o600 })
        .catch(() => {});

    const firstPort = await deps.choosePort(options.port);
    if (!firstPort) {
      io.say(
        options.port
          ? `Port ${options.port} or ${options.port + 1} is taken.`
          : "Ports 8080 to 8085 are taken; pass --port.",
      );
      return CliExitCode.FAILURE;
    }

    const launch = (port: number) =>
      deps.start({
        network: options.network,
        dataDir,
        node,
        runtimeDir,
        binding,
        port,
        logPath,
        frpcPath,
      });

    let handle: LocalServerHandle | null;
    try {
      handle = await launch(firstPort);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The server may have failed before it wrote a line: the log it points
      // at must exist and say why.
      await appendLog(message);
      io.say(message);
      io.event({ type: "server-failed", message, logPath });
      return CliExitCode.FAILURE;
    }

    // `vana connect` finds the server by port scan; this token lets it write.
    const handOver = async (running: LocalServerHandle) => {
      await deps.saveCredentials({
        ...credentials,
        personal_server: {
          url: `http://localhost:${running.port}`,
          session_token: running.accessToken,
          expires_at: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          started_by: "vana-server-start",
        },
      });
    };
    await handOver(handle);
    const url = `http://localhost:${handle.port}`;

    io.say(`Personal Server running at ${url}`);
    io.say(`Owner ${binding.signerAddress}, network ${options.network}.`);

    const publicInput = {
      ...options,
      dataDir,
      accountUrl,
      accessToken: account.session_token,
      ownerAddress: account.address,
      binding,
      io,
      deps,
    };
    let registered = false;
    let publicUrl: string | null = null;
    if (frpcPath) {
      const outcome = await goPublic(handle, publicInput);
      registered = outcome.registered;
      publicUrl = outcome.publicUrl;
    } else {
      io.say(
        "Local only: not registered and not reachable from other devices.",
      );
    }
    io.say(
      "Collect into it with `vana connect <source>`. Press Ctrl+C to stop.",
    );
    io.event({
      type: "server-ready",
      url,
      owner: binding.signerAddress,
      network: options.network,
      registered,
      publicUrl,
      logPath,
    });

    // Supervise: a server that exits on its own (a crash, a kill -9) comes
    // back on the same port, after a wait that grows while it keeps failing.
    let rapidFailures = 0;
    let lastPort = handle.port;
    let runStartedAt = deps.now();
    let lastError: string | null = null;
    for (;;) {
      let exitCode: number | null = null;
      if (handle) {
        const running = handle;
        const reason = await Promise.race([
          stopped,
          running.exited.then(() => "exited" as const),
        ]);
        if (reason === "stopped" || stopping) {
          await running.stop();
          io.say("Stopped.");
          io.event({ type: "server-stopped" });
          return CliExitCode.OK;
        }
        exitCode = await running.exited;
        await running.stop();
        if (deps.now() - runStartedAt >= STABLE_RUN_MS) rapidFailures = 0;
        lastError =
          exitCode === null ? "killed by a signal" : `exit code ${exitCode}`;
      }
      handle = null;
      rapidFailures += 1;

      if (rapidFailures > RESTART_DELAYS_MS.length) {
        const message = `The Personal Server keeps stopping (${lastError}); gave up after ${rapidFailures - 1} restarts. See ${logPath}, then run \`vana server start\`.`;
        await appendLog(message);
        io.say(message);
        io.event({
          type: "server-failed",
          reason: "restart-limit",
          restarts: rapidFailures - 1,
          message,
          logPath,
        });
        return CliExitCode.FAILURE;
      }
      const delayMs = RESTART_DELAYS_MS[rapidFailures - 1];
      const message = `The Personal Server stopped unexpectedly (${lastError}). Restarting in ${Math.round(delayMs / 1000)}s (attempt ${rapidFailures} of ${RESTART_DELAYS_MS.length}).`;
      await appendLog(message);
      io.say(message);
      io.event({
        type: "server-restarting",
        attempt: rapidFailures,
        maxAttempts: RESTART_DELAYS_MS.length,
        delayMs,
        exitCode,
        logPath,
      });
      const waited = await Promise.race([
        stopped,
        deps.sleep(delayMs).then(() => "elapsed" as const),
      ]);
      if (waited === "stopped" || stopping) {
        io.say("Stopped.");
        io.event({ type: "server-stopped" });
        return CliExitCode.OK;
      }

      const port =
        (await deps.choosePort(lastPort)) ??
        (await deps.choosePort(options.port));
      if (!port) {
        lastError = "no free port";
        continue;
      }
      try {
        handle = await launch(port);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await appendLog(lastError);
        continue;
      }
      lastPort = handle.port;
      runStartedAt = deps.now();
      await handOver(handle);
      const restartedUrl = `http://localhost:${handle.port}`;
      // A restart never registers: only the first start asks for that.
      const outcome = frpcPath
        ? await goPublic(handle, { ...publicInput, register: false })
        : { registered: false, publicUrl: null };
      await appendLog(`Restarted at ${restartedUrl}.`);
      io.say(`Restarted. Personal Server running at ${restartedUrl}`);
      io.event({
        type: "server-restarted",
        url: restartedUrl,
        attempt: rapidFailures,
        registered: outcome.registered,
        publicUrl: outcome.publicUrl,
        logPath,
      });
    }
  };
  try {
    return await supervise(ownDir);
  } finally {
    await releaseDataDir();
  }
}

/**
 * Bring a server with a tunnel client online for apps: register it when asked
 * and not yet registered, then report the public URL once the relay answers.
 * Nothing here stops the server; a failure leaves it running local only.
 */
async function goPublic(
  handle: LocalServerHandle,
  input: {
    network: VanaNetworkName;
    dataDir: string;
    noInput?: boolean;
    accountUrl: string;
    accessToken: string;
    ownerAddress: string;
    binding: OwnerBinding;
    io: ServerStartIo;
    deps: ServerStartDeps;
    /** False on a restart: report the tunnel, never ask to register. */
    register?: boolean;
  },
): Promise<{ registered: boolean; publicUrl: string | null }> {
  const { io, deps } = input;
  let state: ServerMessage;
  try {
    // The server checks the gateway and reserves its URL before answering.
    state = await nextMessage(handle, ["public"], 90_000);
  } catch (error) {
    io.say(error instanceof Error ? error.message : String(error));
    return { registered: false, publicUrl: null };
  }
  const publicUrl =
    typeof state.serverUrl === "string" ? state.serverUrl : null;
  const serverAddress =
    typeof state.serverAddress === "string" ? state.serverAddress : null;

  // Report the tunnel whenever it settles; the command keeps running.
  const unsubscribe = handle.onMessage((message) => {
    if (message.type !== "tunnel") return;
    unsubscribe();
    if (message.status === "connected") {
      io.say(`Reachable by apps at ${String(message.url)}`);
    } else {
      io.say(
        `The public URL is not answering yet: ${String(message.warning ?? message.status)}`,
      );
    }
    io.event({
      type: "server-tunnel",
      status: message.status,
      url: message.url ?? null,
      warning: message.warning ?? null,
    });
  });

  if (state.registered === true) {
    io.say(`Registered. Opening ${publicUrl ?? "the public URL"}...`);
    return { registered: true, publicUrl };
  }
  if (!publicUrl || !serverAddress) {
    io.say("The server did not reserve a public URL, so it stays local only.");
    return { registered: false, publicUrl: null };
  }
  if (input.register === false) return { registered: false, publicUrl: null };

  io.say(
    `Registering ${publicUrl} as your Personal Server. This is recorded on-chain and cannot be undone.`,
  );
  try {
    handle.send({ type: "prepare-registration" });
    const prepared = await nextMessage(
      handle,
      ["registration-request", "command-failed"],
      30_000,
    );
    if (prepared.type === "command-failed") {
      throw new Error(String(prepared.message));
    }
    const signed = await deps.signRegistration(
      {
        accountUrl: input.accountUrl,
        accessToken: input.accessToken,
        trustToken: input.binding.trustToken,
        request: prepared.request as RegistrationRequest,
        allowBrowser: !input.noInput,
      },
      {
        openBrowser: deps.openBrowser,
        onConfirmationUrl: (url) =>
          io.say(`Confirm the registration in your browser: ${url}`),
      },
    );
    if (
      signed.signerAddress &&
      signed.signerAddress.toLowerCase() !== input.ownerAddress.toLowerCase()
    ) {
      throw new Error(
        `The registration came back signed by ${signed.signerAddress}, not ${input.ownerAddress}. Nothing was submitted.`,
      );
    }
    handle.send({ type: "submit-registration", signature: signed.signature });
    const submitted = await nextMessage(
      handle,
      ["registration-submitted", "command-failed"],
      60_000,
    );
    if (submitted.type === "command-failed") {
      throw new Error(String(submitted.message));
    }
    await deps.writePublicMarker(input.dataDir, {
      serverAddress,
      serverUrl: publicUrl,
      registeredAt: new Date().toISOString(),
    });
    io.say(`Registered. Opening ${publicUrl}...`);
    io.event({
      type: "server-registered",
      serverAddress,
      serverUrl: publicUrl,
      serverId: submitted.serverId ?? null,
      signing: signed.via,
    });
    return { registered: true, publicUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.say(`Not registered: ${message} The server keeps running, local only.`);
    io.event({
      type: "server-registration-failed",
      needsBrowser: error instanceof RegistrationNeedsBrowserError,
      message,
    });
    return { registered: false, publicUrl: null };
  }
}

/** Events after which nothing more is coming. */
const FINAL_EVENTS = new Set([
  "server-tunnel",
  "server-failed",
  "server-exited",
  "server-already-running",
  "server-needs-login",
  "server-needs-owner-confirmation",
  "server-setup-required",
  "server-owner-confirmation-failed",
]);

/**
 * Start the background server and wait for it, with a spinner and elapsed
 * seconds while nothing is printed: a first start can take a minute.
 */
async function startInBackground(
  options: {
    network: VanaNetworkName;
    dataDir: string;
    port?: number;
    local?: boolean;
  },
  io: ServerStartIo,
  deps: ServerStartDeps,
): Promise<DetachedStart> {
  const progress = io.progress;
  const started = Date.now();
  let label = "Starting your Personal Server";
  let spinning = false;
  const text = () =>
    `${label}... (${Math.round((Date.now() - started) / 1000)}s)`;
  const spin = () => {
    progress?.start(text());
    spinning = Boolean(progress);
  };
  spin();
  const ticker = progress
    ? setInterval(() => {
        if (spinning) progress.update(text());
      }, 1000)
    : null;
  try {
    return await deps.startDetached({
      network: options.network,
      dataDir: options.dataDir,
      port: options.port,
      local: options.local,
      onEvent: (event) => {
        progress?.stop();
        spinning = false;
        sayDetachedEvent(event, io);
        if (event.type === "server-ready" && !event.publicUrl) return;
        if (FINAL_EVENTS.has(String(event.type))) return;
        if (event.type === "server-ready") {
          label = "Waiting for the public URL to answer";
        }
        spin();
      },
    });
  } finally {
    if (ticker) clearInterval(ticker);
    progress?.stop();
  }
}

/** One background-server event, told as it happens. */
function sayDetachedEvent(
  event: Record<string, unknown>,
  io: ServerStartIo,
): void {
  io.event(event);
  const text = (key: string) => String(event[key] ?? "");
  switch (event.type) {
    case "server-registered":
      io.say(`Registered ${text("serverUrl")}.`);
      break;
    case "server-ready":
      io.say(`Personal Server running at ${text("url")}`);
      io.say(`Owner ${text("owner")}, network ${text("network")}.`);
      if (event.publicUrl) {
        // The spinner says it when there is one.
        if (!io.progress) io.say("Waiting for the public URL to answer...");
      } else {
        io.say(
          "Local only: not registered and not reachable from other devices.",
        );
      }
      break;
    case "server-tunnel":
      io.say(
        event.status === "connected"
          ? `Reachable by apps at ${text("url")}`
          : `The public URL is not answering yet: ${text("warning") || text("status")}`,
      );
      break;
    case "server-registration-failed":
      io.say(
        event.needsBrowser
          ? "Not registered: this account confirms registration in a browser. Run `vana server start` once in the foreground."
          : `Not registered: ${text("message")}`,
      );
      break;
    case "server-tunnel-unavailable":
      io.say(`${text("reason")} The server runs local only.`);
      break;
    case "server-already-running":
      io.say(`Your Personal Server is already running at ${text("url")}.`);
      break;
    case "server-failed":
      if (event.message) io.say(text("message"));
      break;
    case "server-restarting":
      io.say(
        `The Personal Server stopped unexpectedly; restarting (attempt ${text("attempt")}).`,
      );
      break;
    case "server-restarted":
      io.say(`Restarted. Personal Server running at ${text("url")}`);
      break;
    default:
      break;
  }
}

/** Whether the background server came up; its events were told already. */
function reportDetached(start: DetachedStart, io: ServerStartIo): number {
  if (!start.ready) {
    // The server's own log when it got as far as writing one, else the
    // background process's output.
    const failed = [...start.events]
      .reverse()
      .find((event) => event.type === "server-failed");
    const logPath =
      typeof failed?.logPath === "string" && fs.existsSync(failed.logPath)
        ? failed.logPath
        : start.logPath;
    io.say(`The background server did not start. See ${logPath}.`);
    return start.events.some((event) => event.type === "server-already-running")
      ? CliExitCode.OK
      : CliExitCode.FAILURE;
  }
  io.say(
    `Running in the background (pid ${start.pid}). Stop it with \`vana server stop\`.`,
  );
  return CliExitCode.OK;
}
