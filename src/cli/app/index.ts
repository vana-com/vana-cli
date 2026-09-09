/**
 * Registration of the `vana app` builder command group.
 *
 * Only the commands that need no pending protocol decision are here:
 * `register` and `whoami`. The consent flow (`request`, `requests`), the
 * read loop, derivatives and write land as their milestones clear.
 */

import type { Command } from "commander";
import { runAppRegister } from "./register.js";
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
    .command("whoami")
    .description("Show the app identity, key source and registration state")
    .action(async () => {
      process.exitCode = await runAppWhoami(getOptions());
    });
}
