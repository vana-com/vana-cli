import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import { CliExitCode } from "../core/exit-codes.js";
import { resolveNetwork } from "../core/network.js";
import { getVanaHome } from "../core/paths.js";
import { findLocalConnector } from "../pdpp/local-connectors.js";
import { loadExportOwner } from "./auth.js";
import {
  assertDesktopHandoffContext,
  desktopHandoffInbox,
  desktopHandoffScopes,
  DesktopHandoffError,
  prepareDesktopHandoff,
  readDesktopHandoff,
  readDesktopHandoffStatus,
  type DesktopHandoffContext,
} from "../pdpp/desktop-handoff.js";

type Globals = {
  json?: boolean;
  ipc?: boolean;
  noInput?: boolean;
  detach?: boolean;
  network?: string;
};
type Options = {
  from?: string;
  streams?: string;
  node?: string;
  open?: boolean;
};
/** External identity and local app transport, injectable without provider or credential access. */
export interface ConnectorDesktopDeps {
  owner: typeof loadExportOwner;
  inbox: () => string;
  open: (url: string) => void;
}
const defaults: ConnectorDesktopDeps = {
  owner: loadExportOwner,
  inbox: desktopHandoffInbox,
  open: (url) => {
    execFileSync("open", [url], { stdio: "ignore" });
  },
};
function shellArg(value: string): string {
  return /^[a-zA-Z0-9_./:=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}
function action(
  command: string,
  id: string,
  context: DesktopHandoffContext,
): { argv: string[] } {
  return {
    argv: [
      "env",
      `VANA_ENV=${context.environment}`,
      `VANA_HOME=${getVanaHome()}`,
      "vana",
      "connectors",
      command,
      id,
      "--network",
      context.network,
      "--json",
    ],
  };
}

/** Prepare, inspect or reopen a same-Mac snapshot; approval belongs exclusively to Desktop. */
export async function runConnectorDesktop(
  operation: "prepare" | "status" | "resume",
  argument: string,
  options: Options,
  globals: Globals,
  deps: Partial<ConnectorDesktopDeps> = {},
): Promise<CliExitCode> {
  const io = { ...defaults, ...deps };
  const machine = globals.json || globals.ipc;
  const emit = (output: Record<string, unknown>, message: string) => {
    process.stdout.write(
      machine
        ? `${JSON.stringify({ schemaVersion: 1, kind: "desktop_connector_handoff", ...output })}\n`
        : `${message}\n`,
    );
  };
  try {
    if (globals.detach)
      throw new DesktopHandoffError(
        "unsupported_detach",
        "Desktop handoffs do not support --detach.",
      );
    if (process.platform !== "darwin")
      throw new DesktopHandoffError(
        "mac_required",
        "This first handoff slice requires Vana Desktop on the same Mac.",
      );
    const network = resolveNetwork(globals.network);
    const owner = io.owner();
    if (!owner) {
      emit(
        {
          ok: false,
          code: "owner_required",
          nextAction: { argv: ["vana", "login"] },
        },
        "Sign in to the intended Vana Account with vana login, then repeat this command.",
      );
      return CliExitCode.CONFIRMATION_REQUIRED;
    }
    if (owner.accountUrl !== network.accountUrl)
      throw new DesktopHandoffError(
        "account_authority_unsupported",
        "This Desktop slice supports the standard Account authority for the selected environment. Clear the custom Account URL and sign in there before packaging.",
      );
    const context: DesktopHandoffContext = {
      ownerAddress: owner.address.toLowerCase(),
      accountUrl: owner.accountUrl as DesktopHandoffContext["accountUrl"],
      environment: network.env,
      network: network.name,
    };
    const inbox = io.inbox();
    let descriptor;
    if (operation === "prepare") {
      const checkout =
        options.from ?? (await findLocalConnector(argument))?.path;
      if (!checkout)
        throw new DesktopHandoffError(
          "checkout_required",
          "Provide --from /absolute/path/to/data-connectors, or register this local connector first.",
        );
      descriptor = await prepareDesktopHandoff({
        checkout,
        source: argument,
        context,
        inbox,
        node: options.node,
        streams: options.streams?.split(",").map((value) => value.trim()),
      });
    } else descriptor = await readDesktopHandoff(inbox, argument);
    assertDesktopHandoffContext(descriptor, context);
    const { sourceId, scopes } = await desktopHandoffScopes(inbox, descriptor);
    const status = await readDesktopHandoffStatus(inbox, descriptor);
    const state = status?.state ?? "pending";
    const openUrl = `${context.environment === "dev" ? "vana-dev" : "vana"}://development-connector?id=${descriptor.handoffId}`;
    const actions = {
      status: action("desktop-status", descriptor.handoffId, context),
      resume: action("desktop-resume", descriptor.handoffId, context),
    };
    let opened = false;
    let openFailed = false;
    if (
      operation !== "status" &&
      options.open &&
      process.stdout.isTTY &&
      !globals.noInput &&
      !machine
    ) {
      try {
        io.open(openUrl);
        opened = true;
      } catch {
        openFailed = true;
      }
    }
    const code =
      state === "enabled"
        ? "desktop_enabled"
        : state === "failed"
          ? "desktop_failed"
          : state === "removed"
            ? "desktop_removed"
            : state === "disabled"
              ? "desktop_disabled"
              : openFailed
                ? "desktop_open_failed"
                : "desktop_approval_required";
    emit(
      {
        ok: state === "enabled",
        code,
        handoffId: descriptor.handoffId,
        artifactDigest: descriptor.artifactDigest,
        connectorId: descriptor.connectorId,
        sourceId,
        scopes,
        version: descriptor.version,
        streams: descriptor.streams,
        context,
        handoffPath: path.join(inbox, descriptor.handoffId, "handoff.json"),
        state,
        ...(status ? { desktopCode: status.code } : {}),
        openUrl,
        opened,
        actions,
        nextAction:
          state === "enabled" ? null : { kind: "desktop_review", url: openUrl },
      },
      `${descriptor.connectorId}@${descriptor.version}: ${state}\nSource: ${sourceId}\nScopes: ${scopes.join(", ")}\nSnapshot: ${descriptor.artifactDigest}\nHandoff: ${path.join(inbox, descriptor.handoffId, "handoff.json")}\n${state === "enabled" ? "Desktop enabled this snapshot. Collection and storage are separate checks." : `Open ${openUrl} in Vana Desktop and review the Development connector. Approval stays in Desktop.`}\nStatus: ${actions.status.argv.map(shellArg).join(" ")}\nResume: ${actions.resume.argv.map(shellArg).join(" ")}`,
    );
    return state === "enabled"
      ? CliExitCode.OK
      : state === "failed"
        ? CliExitCode.FAILURE
        : CliExitCode.CONFIRMATION_REQUIRED;
  } catch (error) {
    const safe = error instanceof DesktopHandoffError;
    const code = safe ? error.code : "desktop_handoff_failed";
    const message = safe
      ? error.message
      : "Could not prepare or inspect the handoff. Check the checkout, selected streams and local packaging tools; no Desktop approval was performed.";
    emit(
      {
        ok: false,
        code,
        message,
        nextAction: { argv: ["vana", "connectors", "desktop", "--help"] },
      },
      message,
    );
    return [
      "checkout_required",
      "invalid_streams",
      "unsupported_detach",
      "unsupported_layout",
      "source_collision",
      "invalid_source_scope",
    ].includes(code)
      ? CliExitCode.USAGE
      : CliExitCode.FAILURE;
  }
}

/** Add commands beside Factory jobs and mutable source registration. */
export function registerConnectorDesktopCommands(
  parent: Command,
  globals: () => Globals,
): void {
  parent
    .command("desktop <key>")
    .description(
      "Package a frozen private connector for Vana Desktop on this Mac",
    )
    .option(
      "--from <dir>",
      "Public data-connectors checkout containing the connector and artifact builder",
    )
    .option(
      "--streams <names>",
      "Comma-separated declared streams (default: all)",
    )
    .option(
      "--node <path>",
      "Real Node 24 executable used by the public artifact builder",
    )
    .option(
      "--open",
      "Open Desktop review on an interactive terminal; never approves it",
    )
    .action(async (key: string, options: Options) => {
      process.exitCode = await runConnectorDesktop(
        "prepare",
        key,
        options,
        globals(),
      );
    });
  parent
    .command("desktop-status <handoff-id>")
    .description(
      "Verify a frozen snapshot and inspect its Desktop approval status",
    )
    .action(async (id: string) => {
      process.exitCode = await runConnectorDesktop("status", id, {}, globals());
    });
  parent
    .command("desktop-resume <handoff-id>")
    .description(
      "Resume the same Desktop handoff without repackaging or duplicate activation",
    )
    .option(
      "--open",
      "Open Desktop review on an interactive terminal; never approves it",
    )
    .action(async (id: string, options: Options) => {
      process.exitCode = await runConnectorDesktop(
        "resume",
        id,
        options,
        globals(),
      );
    });
}
