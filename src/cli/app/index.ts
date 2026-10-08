/**
 * Registration of the `vana app` builder command group.
 *
 * Only the commands that need no pending protocol decision are here:
 * `register` and `whoami`. The consent flow (`request`, `requests`), the
 * read loop, derivatives and write land as their milestones clear.
 */

import type { Command } from "commander";
import { runAppClaim } from "./claim.js";
import { runAppEscrowBalance, runAppEscrowFund } from "./escrow.js";
import { runAppOnchain } from "./onchain.js";
import { runAppRead } from "./read.js";
import { runAppAsk } from "./ask.js";
import { runAppLineage, runAppStatus } from "./derivatives.js";
import { runAppRegister } from "./register.js";
import { runAppRequest } from "./request.js";
import { runAppRequestsList, runAppRequestsShow } from "./requests.js";
import { runAppWhoami } from "./whoami.js";
import type { AppCommandOptions } from "./outcome.js";

export function registerAppCommands(
  program: Command,
  getOptions: () => AppCommandOptions,
): void {
  const app = program
    .command("app")
    .description("Builder-side protocol operations");

  app
    .command("register")
    .description("Register this app as a builder at the gateway (idempotent)")
    .option("--app-url <url>", "Public URL stored on the builder record")
    .option(
      "--app-name <name>",
      "Name people see when this app asks for access (remembered)",
    )
    .action(async (commandOptions: { appUrl?: string; appName?: string }) => {
      process.exitCode = await runAppRegister({
        ...getOptions(),
        appUrl: commandOptions.appUrl,
        appName: commandOptions.appName,
      });
    });

  app
    .command("request")
    .description("Ask a person for access and wait for the grant")
    .option(
      "--scopes <list>",
      "Comma-separated scopes to request (with --question, defaults to --derived)",
    )
    .option(
      "--remove-scopes <list>",
      "Comma-separated scopes the app's live grant should drop",
    )
    .option(
      "--owner <address>",
      "Whose live grant to extend, when more than one person approved this app",
    )
    .option(
      "--no-merge-grant",
      "Send --scopes verbatim instead of keeping what the live grant covers",
    )
    .option("--question <text>", "Derivative question to carry on the request")
    .option("--derived <scope>", "Scope the answer is written to")
    .option(
      "--sources <list>",
      "Comma-separated scopes the answer is computed from, never granted to the app",
    )
    .option("--return-url <url>", "Where approval returns the person")
    .option(
      "--timeout <seconds>",
      "How long to wait for approval (default 600)",
    )
    .option("--app-id <id>", "App id shown during approval")
    .option("--app-name <name>", "App name shown during approval")
    .option("--app-url <url>", "App homepage shown during approval")
    .action(
      async (commandOptions: Record<string, string | boolean | undefined>) => {
        process.exitCode = await runAppRequest({
          ...getOptions(),
          ...commandOptions,
        });
      },
    );

  const requests = app
    .command("requests")
    .description("Access requests created from this machine");
  requests
    .command("list")
    .description("List access requests this machine created")
    .action(async () => {
      process.exitCode = await runAppRequestsList(getOptions());
    });
  requests
    .command("show <requestId>")
    .description("Show one access request, refreshed from the service")
    .action(async (requestId: string) => {
      process.exitCode = await runAppRequestsShow(requestId, getOptions());
    });

  app
    .command("read <scope>")
    .description("Read granted data from the owner's Personal Server")
    .option("--grant <id>", "Grant id covering the scope")
    .option("--pay", "Settle a 402 payment from escrow")
    .option("--max-fee <amount>", "Refuse fees above this, in the fee's asset")
    .option("--server <url>", "Explicit Personal Server URL")
    .action(
      async (
        scope: string,
        commandOptions: {
          grant?: string;
          pay?: boolean;
          maxFee?: string;
          server?: string;
        },
      ) => {
        process.exitCode = await runAppRead(scope, {
          ...getOptions(),
          ...commandOptions,
        });
      },
    );

  const escrow = app
    .command("escrow")
    .description("Escrow balance and funding for paid reads");
  escrow
    .command("balance")
    .description("What the app can spend from escrow")
    .action(async () => {
      process.exitCode = await runAppEscrowBalance(getOptions());
    });
  escrow
    .command("fund")
    .description(
      "Deposit into escrow, native VANA or an ERC20 (an ERC20 goes through the gateway relayer, which pays the gas)",
    )
    .option("--amount <amount>", "Amount to deposit, in the asset's units")
    .option("--asset <address>", "ERC20 to deposit instead of native VANA")
    .option(
      "--self-pay-gas",
      "Send an ERC20 deposit from the app wallet instead of the gateway relayer (needs VANA for gas)",
    )
    .action(
      async (commandOptions: {
        amount?: string;
        asset?: string;
        selfPayGas?: boolean;
      }) => {
        process.exitCode = await runAppEscrowFund({
          ...getOptions(),
          ...commandOptions,
        });
      },
    );

  app
    .command("onchain <scope>")
    .description("On-chain trace of a data point (version, hashes, deletion)")
    .option("--owner <address>", "Data owner address")
    .action(async (scope: string, commandOptions: { owner?: string }) => {
      process.exitCode = await runAppOnchain(scope, {
        ...getOptions(),
        ...commandOptions,
      });
    });

  app
    .command("ask <question>")
    .description("Ask a question about a person's data, through consent")
    .requiredOption(
      "--sources <list>",
      "Required. Comma-separated scopes the answer is computed from, never granted to the app",
    )
    .requiredOption(
      "--derived <scope>",
      "Required. Scope the answer is written to and the only one granted, in your own namespace (e.g. myapp.languages)",
    )
    .option("--pay", "Settle the derived-scope read from escrow")
    .option("--max-fee <amount>", "Refuse fees above this, in the fee's asset")
    .option("--timeout <seconds>", "How long to wait for approval")
    .option(
      "--registered",
      "Use the builder-registered path instead of consent",
    )
    .action(
      async (question: string, commandOptions: Record<string, unknown>) => {
        process.exitCode = await runAppAsk(question, {
          ...getOptions(),
          ...commandOptions,
        });
      },
    );

  app
    .command("status <derivedScope>")
    .description("Is the answer coming, and when")
    .option("--grant <id>", "Grant covering the derived scope")
    .option("--server <url>", "Personal Server URL")
    .action(
      async (derivedScope: string, commandOptions: Record<string, unknown>) => {
        process.exitCode = await runAppStatus(derivedScope, {
          ...getOptions(),
          ...commandOptions,
        });
      },
    );

  app
    .command("lineage <scope>")
    .description("Where an answer came from, redacted where it must be")
    .option("--grant <id>", "Grant covering the scope")
    .option("--server <url>", "Personal Server URL")
    .action(async (scope: string, commandOptions: Record<string, unknown>) => {
      process.exitCode = await runAppLineage(scope, {
        ...getOptions(),
        ...commandOptions,
      });
    });

  app
    .command("claim")
    .description(
      "Print a link that adds this app to its owner's Vana Account, to fund its escrow",
    )
    .option(
      "--app-name <name>",
      "Name the owner sees in their Account (remembered; defaults to the one from register)",
    )
    .action(async (commandOptions: { appName?: string }) => {
      process.exitCode = await runAppClaim({
        ...getOptions(),
        appName: commandOptions.appName,
      });
    });

  app
    .command("whoami")
    .description("Show the app identity, key source and registration state")
    .action(async () => {
      process.exitCode = await runAppWhoami(getOptions());
    });
}
