import { CliExitCode } from "../core/exit-codes.js";
import { sameExportOwner, type ExportOwner } from "../core/source-export.js";
import {
  personalServerOwnerMismatch,
  type PersonalServerTarget,
} from "../personal-server/index.js";

interface Session {
  authenticated: boolean;
  owner: ExportOwner;
}

interface Problem {
  ready: false;
  exitCode: CliExitCode;
  reason: string;
  message: string;
  remedy: string;
  personalServerUrl?: string;
  personalServerOwner?: string;
  account?: string;
}

interface Ready {
  ready: true;
  owner: NonNullable<ExportOwner>;
  target: PersonalServerTarget;
  allowForeignServer: boolean;
}

/** External account/server operations used by every collection entry point. */
export interface CollectionReadinessDependencies {
  interactive: boolean;
  session(): Session;
  signIn(): Promise<number>;
  detectServer(): Promise<PersonalServerTarget>;
  prepareServer(owner: NonNullable<ExportOwner>): Promise<void>;
  approveServer(target: PersonalServerTarget): Promise<number>;
  confirmForeignServer(target: PersonalServerTarget): Promise<boolean>;
  checkAccess(
    target: PersonalServerTarget,
  ): Promise<"ready" | "auth" | "unavailable">;
  serverStartCommand: string;
  serverApprovalCommand(target: PersonalServerTarget): string;
}

/** Settle identity and destination before any connector input or provider access. */
export async function prepareCollection(
  deps: CollectionReadinessDependencies,
): Promise<Ready | Problem> {
  const signInRequired = (): Problem => ({
    ready: false,
    exitCode: CliExitCode.CONFIRMATION_REQUIRED,
    reason: "vana_sign_in_required",
    message:
      "Sign in to Vana before collecting data. A session with a known account owner is required.",
    remedy: "vana login",
  });
  let session = deps.session();
  if (session.authenticated && !session.owner) {
    return {
      ...signInRequired(),
      reason: "vana_owner_unknown",
      message:
        "The supplied session does not identify the collecting account. Clear VANA_SESSION_TOKEN and use a saved Vana sign-in for collection.",
    };
  }
  if (!session.authenticated || !session.owner) {
    if (!deps.interactive) return signInRequired();
    if ((await deps.signIn()) !== CliExitCode.OK) return signInRequired();
    session = deps.session();
    if (!session.authenticated || !session.owner) return signInRequired();
  }
  const owner = session.owner;
  let target = await deps.detectServer();
  if (target.state !== "available" || !target.url) {
    if (deps.interactive) {
      await deps.prepareServer(owner);
      target = await deps.detectServer();
    }
    if (target.state !== "available" || !target.url) {
      return {
        ready: false,
        exitCode: CliExitCode.SERVER_UNAVAILABLE,
        reason: "personal_server_unavailable",
        message: "Your Personal Server must be ready before collecting data.",
        remedy: deps.serverStartCommand,
      };
    }
  }
  if (!target.health?.owner) {
    return {
      ready: false,
      exitCode: CliExitCode.SERVER_UNAVAILABLE,
      reason: "personal_server_owner_unknown",
      message:
        "The Personal Server has not reported its owner. No source data was requested.",
      remedy: "vana server status",
    };
  }
  const foreign = personalServerOwnerMismatch(
    target.health.owner,
    owner.address,
  );
  let allowForeignServer = false;
  if (foreign) {
    allowForeignServer =
      deps.interactive && (await deps.confirmForeignServer(target));
    if (!allowForeignServer) {
      return {
        ready: false,
        exitCode: CliExitCode.SERVER_UNAVAILABLE,
        reason: "personal_server_not_yours",
        message: `The Personal Server at ${target.url} belongs to ${foreign.owner}, but you are signed in as ${owner.address}. No source data was requested.`,
        remedy: deps.serverStartCommand,
        personalServerUrl: target.url,
        personalServerOwner: foreign.owner,
        account: owner.address,
      };
    }
  }
  let access = await deps.checkAccess(target);
  if (access === "auth" && deps.interactive) {
    if ((await deps.approveServer(target)) === CliExitCode.OK) {
      access = await deps.checkAccess(target);
    }
  }
  if (access !== "ready") {
    return {
      ready: false,
      exitCode:
        access === "auth"
          ? CliExitCode.CONFIRMATION_REQUIRED
          : CliExitCode.SERVER_UNAVAILABLE,
      reason:
        access === "auth"
          ? "personal_server_approval_required"
          : "personal_server_unavailable",
      message:
        access === "auth"
          ? "Approve this CLI on your Personal Server before collecting data."
          : "Your Personal Server could not be reached. No source data was requested.",
      remedy:
        access === "auth"
          ? deps.serverApprovalCommand(target)
          : "vana server status",
    };
  }
  const current = deps.session();
  if (!current.authenticated || !sameExportOwner(owner, current.owner)) {
    return {
      ...signInRequired(),
      reason: "collection_account_changed",
      message:
        "The Vana account changed while preparing collection. Retry under the intended account.",
    };
  }
  return { ready: true, owner, target, allowForeignServer };
}
