import { execSync } from "node:child_process";
import path from "node:path";

import {
  readCliConfig as readCliConfigDefault,
  updateCliConfig as updateCliConfigDefault,
} from "../core/index.js";
import type { CliConfig, LocalConnectorEntry } from "../core/index.js";
import { resolveLocalLaunch as resolveLocalLaunchDefault } from "./local.js";
import { findPdppPin, type PdppPin } from "./pins.js";

export type { LocalConnectorEntry } from "../core/index.js";

/** What `vana connectors add|list|remove` and the runtime need from outside. */
export interface LocalConnectorDeps {
  readCliConfig: () => Promise<CliConfig>;
  updateCliConfig: (patch: Partial<CliConfig>) => Promise<void>;
  resolveLocalLaunch: typeof resolveLocalLaunchDefault;
  /** The checkout's commit, or undefined when it is not a git repository. */
  gitHead: (dir: string) => string | undefined;
  now: () => Date;
}

function gitHeadDefault(dir: string): string | undefined {
  try {
    const head = execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

export const defaultLocalConnectorDeps: LocalConnectorDeps = {
  readCliConfig: readCliConfigDefault,
  updateCliConfig: updateCliConfigDefault,
  resolveLocalLaunch: resolveLocalLaunchDefault,
  gitHead: gitHeadDefault,
  now: () => new Date(),
};

function withDefaults(deps: Partial<LocalConnectorDeps>): LocalConnectorDeps {
  return { ...defaultLocalConnectorDeps, ...deps };
}

/** Every saved local connector, keyed by connector key. */
export async function readLocalConnectors(
  deps: Partial<LocalConnectorDeps> = {},
): Promise<Record<string, LocalConnectorEntry>> {
  const config = await withDefaults(deps).readCliConfig();
  return config.localConnectors ?? {};
}

/** The saved local connector for a source, if any. */
export async function findLocalConnector(
  source: string,
  deps: Partial<LocalConnectorDeps> = {},
): Promise<LocalConnectorEntry | null> {
  const entries = await readLocalConnectors(deps);
  return entries[source.toLowerCase()] ?? null;
}

/** Why `vana connectors add` refuses a key without `--force`. */
export type LocalConnectorConflict = "pinned" | "legacy";

export class LocalConnectorConflictError extends Error {
  constructor(
    readonly key: string,
    readonly conflicts: LocalConnectorConflict[],
  ) {
    super(
      `${key} is already ${describeConflicts(conflicts)}. A local connector with the same key would share its state, browser profile and scope names. Pass --force to register it anyway.`,
    );
    this.name = "LocalConnectorConflictError";
  }
}

function describeConflicts(conflicts: LocalConnectorConflict[]): string {
  const parts = conflicts.map((conflict) =>
    conflict === "pinned"
      ? "a pinned Collection Profile connector"
      : "a connector in the legacy registry",
  );
  return parts.join(" and ");
}

export interface AddLocalConnectorOptions {
  /** Register even when the key collides with a pinned or legacy connector. */
  force?: boolean;
  /**
   * Ids the catalog already lists without local entries; a match is a
   * `legacy` conflict. Pins are checked here regardless.
   */
  catalogIds?: Iterable<string>;
}

export interface AddLocalConnectorResult {
  key: string;
  entry: LocalConnectorEntry;
  /** Conflicts that `--force` overrode; empty when there were none. */
  conflicts: LocalConnectorConflict[];
  /** True when the key was already registered and its entry was replaced. */
  replaced: boolean;
}

/**
 * Validate a checkout for `key` the same way a run would, then save it.
 * The stored path is absolute so a schedule or a detached run started
 * from any working directory finds the same code.
 */
export async function addLocalConnector(
  rawKey: string,
  dir: string,
  options: AddLocalConnectorOptions = {},
  deps: Partial<LocalConnectorDeps> = {},
): Promise<AddLocalConnectorResult> {
  const resolved = withDefaults(deps);
  const key = rawKey.toLowerCase();
  const absolute = path.resolve(dir);

  const conflicts: LocalConnectorConflict[] = [];
  if (findPdppPin(key)) conflicts.push("pinned");
  for (const id of options.catalogIds ?? []) {
    if (id.toLowerCase() === key && !conflicts.includes("legacy")) {
      conflicts.push("legacy");
    }
  }
  if (conflicts.length > 0 && !options.force) {
    throw new LocalConnectorConflictError(key, conflicts);
  }

  const launch = await resolved.resolveLocalLaunch(absolute, key);
  const humanInteraction = launch.profile.capabilities?.human_interaction;
  const entry: LocalConnectorEntry = {
    path: absolute,
    addedAt: resolved.now().toISOString(),
    displayName: launch.displayName,
    version: launch.version,
  };
  const gitHead = resolved.gitHead(absolute);
  if (gitHead) entry.gitHead = gitHead;
  if (Array.isArray(humanInteraction) && humanInteraction.length > 0) {
    entry.humanInteraction = humanInteraction.filter(
      (value): value is string => typeof value === "string",
    );
  }

  const existing = await readLocalConnectors(deps);
  await resolved.updateCliConfig({
    localConnectors: { ...existing, [key]: entry },
  });
  return { key, entry, conflicts, replaced: key in existing };
}

/** Forget a saved local connector. Returns false when none was saved. */
export async function removeLocalConnector(
  rawKey: string,
  deps: Partial<LocalConnectorDeps> = {},
): Promise<boolean> {
  const resolved = withDefaults(deps);
  const key = rawKey.toLowerCase();
  const existing = await readLocalConnectors(deps);
  if (!(key in existing)) return false;
  const { [key]: _removed, ...rest } = existing;
  await resolved.updateCliConfig({ localConnectors: rest });
  return true;
}

/**
 * Where a Collection Profile connector for a source comes from, in the
 * order a run consults them: an explicit `--from`, then the saved local
 * entry, then the pinned artifact.
 */
export type PdppSourceResolution =
  | { kind: "from"; path: string }
  | { kind: "local"; path: string; entry: LocalConnectorEntry }
  | { kind: "pinned"; pin: PdppPin };

export async function resolvePdppSource(
  source: string,
  options: { from?: string } = {},
  deps: Partial<LocalConnectorDeps> = {},
): Promise<PdppSourceResolution | null> {
  if (options.from) {
    return { kind: "from", path: path.resolve(options.from) };
  }
  const entry = await findLocalConnector(source, deps);
  if (entry) return { kind: "local", path: entry.path, entry };
  const pin = findPdppPin(source);
  return pin ? { kind: "pinned", pin } : null;
}
