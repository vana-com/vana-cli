import fs from "node:fs";
import path from "node:path";

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
  runningServerPid,
  startDetachedServer,
  type DetachedStart,
} from "../personal-server/local/detach.js";
import { localServerDataDir } from "../personal-server/local/config.js";
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
  readPublicMarker: (network: VanaNetworkName) => PublicMarker | null;
  writePublicMarker: (
    network: VanaNetworkName,
    marker: PublicMarker,
  ) => Promise<void>;
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
    resolveFrpc: () => resolveFrpc(),
    installFrpc: (logPath) => installFrpc(logPath),
    signRegistration: signServerRegistration,
    readPublicMarker,
    writePublicMarker,
    startDetached: startDetachedServer,
    runningServerCharges,
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
  if (!identity || !runningServerPid(network)) return null;
  const dir = localServerDataDir(network);
  const key = readJson(path.join(dir, "key.json"));
  if (
    typeof key?.address !== "string" ||
    key.address.toLowerCase() !== identity.toLowerCase()
  ) {
    return null;
  }
  const config = readJson(path.join(dir, "server.json"));
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

  // Public unless asked to stay local, as Desktop's server is. A registered
  // server started --local stays registered, and apps find it offline.
  const marker = deps.readPublicMarker(options.network);
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
  const runtimeDir = await deps.ensureRuntime(node, logPath);
  let frpcPath: string | null = frpc?.kind === "ready" ? frpc.path : null;
  if (frpcNeeded) {
    io.say("Installing the tunnel client (one time)...");
    frpcPath = await deps.installFrpc(logPath);
  }

  // Everything that needed a person is done: the rest runs in the
  // background, as a second `vana server start` that outlives this one.
  if (options.detach) {
    io.say("Starting in the background...");
    return reportDetached(
      await deps.startDetached({
        network: options.network,
        port: options.port,
        local: options.local,
      }),
      io,
    );
  }

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
      frpcPath,
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
      started_by: "vana-server-start",
    },
  });

  io.say(`Personal Server running at ${url}`);
  io.say(`Owner ${binding.signerAddress}, network ${options.network}.`);

  let registered = false;
  let publicUrl: string | null = null;
  if (frpcPath) {
    const outcome = await goPublic(handle, {
      ...options,
      accountUrl,
      accessToken: account.session_token,
      ownerAddress: account.address,
      binding,
      io,
      deps,
    });
    registered = outcome.registered;
    publicUrl = outcome.publicUrl;
  } else {
    io.say("Local only: not registered and not reachable from other devices.");
  }
  io.say("Collect into it with `vana connect <source>`. Press Ctrl+C to stop.");
  io.event({
    type: "server-ready",
    url,
    owner: binding.signerAddress,
    network: options.network,
    registered,
    publicUrl,
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

/**
 * Bring a server with a tunnel client online for apps: register it when asked
 * and not yet registered, then report the public URL once the relay answers.
 * Nothing here stops the server; a failure leaves it running local only.
 */
async function goPublic(
  handle: LocalServerHandle,
  input: {
    network: VanaNetworkName;
    noInput?: boolean;
    accountUrl: string;
    accessToken: string;
    ownerAddress: string;
    binding: OwnerBinding;
    io: ServerStartIo;
    deps: ServerStartDeps;
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
    await deps.writePublicMarker(input.network, {
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

/** Say what the background server reported, and whether it came up. */
function reportDetached(start: DetachedStart, io: ServerStartIo): number {
  for (const event of start.events) {
    io.event(event);
    const text = (key: string) => String(event[key] ?? "");
    switch (event.type) {
      case "server-ready":
        io.say(`Personal Server running at ${text("url")}`);
        io.say(`Owner ${text("owner")}, network ${text("network")}.`);
        if (!event.publicUrl) {
          io.say(
            "Local only: not registered and not reachable from other devices.",
          );
        }
        break;
      case "server-registered":
        io.say(`Registered ${text("serverUrl")}.`);
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
      default:
        break;
    }
  }
  if (!start.ready) {
    io.say(`The background server did not start. See ${start.logPath}.`);
    return start.events.some((event) => event.type === "server-already-running")
      ? CliExitCode.OK
      : CliExitCode.FAILURE;
  }
  io.say(
    `Running in the background (pid ${start.pid}). Stop it with \`vana server stop\`.`,
  );
  return CliExitCode.OK;
}
