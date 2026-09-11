/**
 * Registration of the `vana app` builder command group.
 *
 * Only the commands that need no pending protocol decision are here:
 * `register` and `whoami`. The consent flow (`request`, `requests`), the
 * read loop, derivatives and write land as their milestones clear.
 */

import type { Command } from "commander";
import { runAppEscrowBalance, runAppEscrowFund } from "./escrow.js";
import { runAppOnchain } from "./onchain.js";
import { runAppRead } from "./read.js";
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
    .action(async (commandOptions: { appUrl?: string }) => {
      process.exitCode = await runAppRegister({
        ...getOptions(),
        appUrl: commandOptions.appUrl,
      });
    });

  app
    .command("request")
    .description("Ask a person for access and wait for the grant")
    .option("--scopes <list>", "Comma-separated scopes to request")
    .option("--question <text>", "Derivative question to carry on the request")
    .option("--derived <scope>", "Scope the answer is written to")
    .option(
      "--sources <list>",
      "Comma-separated scopes the answer is computed from",
    )
    .option("--return-url <url>", "Where approval returns the person")
    .option(
      "--timeout <seconds>",
      "How long to wait for approval (default 600)",
    )
    .option("--app-id <id>", "App id shown during approval")
    .option("--app-name <name>", "App name shown during approval")
    .option("--app-url <url>", "App homepage shown during approval")
    .action(async (commandOptions: Record<string, string | undefined>) => {
      process.exitCode = await runAppRequest({
        ...getOptions(),
        ...commandOptions,
      });
    });

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
    .option("--max-fee <vana>", "Refuse fees above this amount, in VANA")
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
      "Deposit VANA into escrow (on-chain tx + gateway registration)",
    )
    .option("--amount <amount>", "Amount to deposit, in the asset's units")
    .option("--asset <address>", "ERC20 to deposit instead of native VANA")
    .action(async (commandOptions: { amount?: string; asset?: string }) => {
      process.exitCode = await runAppEscrowFund({
        ...getOptions(),
        ...commandOptions,
      });
    });

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
    .command("whoami")
    .description("Show the app identity, key source and registration state")
    .action(async () => {
      process.exitCode = await runAppWhoami(getOptions());
    });
}
