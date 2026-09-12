/**
 * `vana app ask "<question>" --sources a,b --derived <scope>`
 *
 * The consent path by default: the question travels inside an access
 * request, so the person approves the question itself and the app ends up
 * holding a grant on the answer rather than on the sources it was computed
 * from. `--registered` switches to the builder-registered path, which needs
 * a read grant on every source scope and says so.
 *
 * This composes commands that already exist rather than reimplementing
 * them: it creates the request, waits for the answer to settle, and reads
 * the derived scope through the same escrow path, gates and receipts as any
 * other read. Costs are reported separately (see derivatives.ts).
 */

import {
  UnknownNetworkError,
  resolveNetwork,
  type ResolvedNetwork,
} from "../../core/network.js";
import { emitAppOutcome, type AppCommandOptions } from "./outcome.js";
import { runAppRead, type ReadCommandOptions } from "./read.js";
import { runAppRequest, type RequestCommandOptions } from "./request.js";
import { runAppStatus } from "./derivatives.js";
import { createRequestsStore } from "../../core/requests-store.js";

/** Newest approved grant covering a scope, from the local request index. */
function findGrantForScope(scope: string, network: string): string | null {
  return (
    createRequestsStore()
      .list({ network })
      .find(
        (entry) =>
          Boolean(entry.grantId) &&
          (entry.approvedScopes ?? entry.scopes).includes(scope),
      )?.grantId ?? null
  );
}

export interface AskCommandOptions extends AppCommandOptions {
  sources?: string;
  derived?: string;
  /** Settle the derived-scope read from escrow. */
  pay?: boolean;
  maxFee?: string;
  timeout?: string;
  /**
   * Register the question as a builder instead of carrying it through
   * consent. Needs a read grant on every source scope.
   */
  registered?: boolean;
}

export interface AskDeps {
  request?: typeof runAppRequest;
  status?: typeof runAppStatus;
  read?: typeof runAppRead;
}

export async function runAppAsk(
  question: string,
  options: AskCommandOptions,
  deps: AskDeps = {},
): Promise<number> {
  let network: ResolvedNetwork;
  try {
    network = resolveNetwork(options.network);
  } catch (error) {
    if (error instanceof UnknownNetworkError) {
      return emitAppOutcome(options, {
        status: "failed",
        code: "bad_usage",
        message: error.message,
      });
    }
    throw error;
  }

  const sources = (options.sources ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!question.trim() || sources.length === 0 || !options.derived) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message: "ask needs a question, --sources and --derived.",
      remedy: `vana app ask "..." --sources spotify.history --derived myapp.summary`,
      network: network.name,
    });
  }

  if (options.registered) {
    // Honest refusal rather than a half-path: registering a question as the
    // builder requires a read grant on every source scope, which is exactly
    // the access the consent path is designed to avoid. Until someone needs
    // it, say so instead of pretending.
    return emitAppOutcome(options, {
      status: "failed",
      code: "bad_usage",
      message:
        "--registered is not wired yet. It needs a read grant on every source scope, which the consent path deliberately avoids.",
      remedy: `drop --registered to ask through consent`,
      network: network.name,
    });
  }

  // 1. Ask the person. The derived scope must also be granted as a plain
  //    read so the answer can be read back; request validates that.
  const requestOptions: RequestCommandOptions = {
    ...options,
    scopes: [...sources, options.derived].join(","),
    question,
    derived: options.derived,
    sources: options.sources,
  };
  const requestExit = await (deps.request ?? runAppRequest)(requestOptions);
  if (requestExit !== 0) {
    // request already emitted a precise outcome (7 when a person must act,
    // 3 on denial, 6 on timeout); nothing to add.
    return requestExit;
  }

  // 2. Wait for the answer to settle on the owner's server.
  const statusExit = await (deps.status ?? runAppStatus)(
    options.derived,
    options,
  );
  if (statusExit !== 0) {
    return statusExit;
  }

  // 3. Read the answer, through the ordinary billable read path. The grant
  //    comes from the request just approved; read resolves the owner and the
  //    server from it.
  const grantId = findGrantForScope(options.derived, network.name);
  if (!grantId) {
    return emitAppOutcome(options, {
      status: "failed",
      code: "grant_invalid",
      message: "The request was approved but no grant id was recorded.",
      remedy: "vana app requests list",
      network: network.name,
    });
  }
  const readOptions: ReadCommandOptions = {
    ...options,
    grant: grantId,
    pay: options.pay,
    maxFee: options.maxFee,
  };
  return (deps.read ?? runAppRead)(options.derived, readOptions);
}
