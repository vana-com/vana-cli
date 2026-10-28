import path from "node:path";

import { CliExitCode } from "../core/exit-codes.js";
import { readCliState, updateCliConfig } from "../core/state-store.js";
import { confirm } from "../cli/prompts.js";
import { findSkillsDir, getSkillInstallDirs } from "./paths.js";
import { installSkill } from "./registry.js";

const DEFAULT_SKILLS = ["connect-data", "create-connector", "builder"];

interface SkillSetupOptions {
  interactive: boolean;
  /** Explicit `vana skills setup` can revisit an earlier decision. */
  force?: boolean;
}

/** Offer the public skill bundle only at a human terminal, before copying files. */
export async function offerSkillSetup(
  options: SkillSetupOptions,
  deps = { confirm },
): Promise<number> {
  if (!options.interactive) return CliExitCode.OK;

  try {
    const state = await readCliState();
    if (!options.force && state.config?.skillsPromptCompleted) {
      return CliExitCode.OK;
    }

    const installDirs = getSkillInstallDirs();
    process.stderr.write(
      `\nVana can add Connect Data, Create Connector and Builder instructions for your agent.\nDestinations: ${installDirs.map((dir) => path.join(dir, "vana-<skill>")).join(", ")}\nExisting copies of these three skills will be replaced.\n`,
    );
    const accepted = await deps.confirm(
      { message: "Install the three public Vana skills?", default: false },
      { output: process.stderr },
    );
    if (!accepted) {
      await updateCliConfig({ skillsPromptCompleted: true });
      return CliExitCode.OK;
    }

    // Use the files shipped with this CLI; setup never fetches from GitHub.
    const skillsDir = findSkillsDir();
    if (!skillsDir)
      throw new Error("The bundled skills are missing. Reinstall Vana.");
    for (const id of DEFAULT_SKILLS) {
      await installSkill(id, skillsDir);
    }
    await updateCliConfig({ skillsPromptCompleted: true });
    process.stderr.write(
      "Installed the three Vana skills. In Claude Code, use /reload-skills if they are not visible.\n",
    );
    return CliExitCode.OK;
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return CliExitCode.OK;
    }
    process.stderr.write(
      `Vana skill setup did not finish: ${error instanceof Error ? error.message : String(error)}\nTry again with vana skills setup.\n`,
    );
    return CliExitCode.FAILURE;
  }
}

/** Whether an install hook has a human terminal that can answer the offer. */
export function canOfferSkillSetup(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.stderr.isTTY &&
    !process.env.CI &&
    !process.env.AGENT &&
    !process.env.VANA_DETACHED,
  );
}
