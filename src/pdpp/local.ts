import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  parseCollectionProfile,
  type CollectionProfile,
  type PdppLaunch,
} from "./profile.js";

/** The published artifacts' range, used when a checkout declares none. */
const DEFAULT_NODE_RANGE = ">=24.15.0 <25";

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Nearest directory at or above `start`, up to `stop`, with tsx installed. */
function findToolRoot(start: string, stop: string): string | null {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, "node_modules", "tsx"))) {
      return current;
    }
    if (current === stop || path.dirname(current) === current) return null;
    current = path.dirname(current);
  }
}

/** Where one connector's entry point and manifest are in a checkout. */
export interface LocalConnectorFiles {
  /** The directory passed in, resolved to an absolute path. */
  root: string;
  entry: string;
  manifestPath: string;
}

/**
 * Locate a connector in a checkout without reading anything. Both layouts
 * are accepted: connectors at the root (`connectors/<key>/index.ts` with
 * `connectors/<key>/manifest.json`), and the earlier
 * `packages/polyfill-connectors/connectors/<key>/index.ts` with
 * `manifests/<key>.json`.
 */
export function findLocalConnectorFiles(
  checkout: string,
  source: string,
): LocalConnectorFiles {
  const root = path.resolve(checkout);
  const key = source.toLowerCase();
  const bases = [root, path.join(root, "packages", "polyfill-connectors")];

  for (const base of bases) {
    const entry = path.join(base, "connectors", key, "index.ts");
    if (!fs.existsSync(entry)) continue;
    const manifestPath = firstExisting([
      path.join(base, "connectors", key, "manifest.json"),
      path.join(base, "manifests", `${key}.json`),
    ]);
    if (!manifestPath) {
      throw new Error(`Found ${entry} but no manifest for ${key}.`);
    }
    return { root, entry, manifestPath };
  }

  throw new Error(
    `No connector named ${key} in ${root}. Looked for connectors/${key}/index.ts at the root and under packages/polyfill-connectors.`,
  );
}

/**
 * Read and validate a connector's manifest from a checkout. The manifest
 * has to name the same connector it sits under: the key is what state,
 * the browser profile and every ingested scope are filed under, so a
 * mismatch would quietly mix two connectors' data.
 */
export async function readLocalProfile(
  checkout: string,
  source: string,
): Promise<{ files: LocalConnectorFiles; profile: CollectionProfile }> {
  const files = findLocalConnectorFiles(checkout, source);
  const profile = parseCollectionProfile(
    JSON.parse(await fsp.readFile(files.manifestPath, "utf8")),
    files.manifestPath,
  );
  const key = source.toLowerCase();
  if (profile.connector_key.toLowerCase() !== key) {
    throw new Error(
      `${files.manifestPath} declares connector_key ${profile.connector_key}, not ${key}.`,
    );
  }
  return { files, profile };
}

/**
 * Run a connector from a data-connectors checkout instead of a signed
 * artifact, the way `connector-dev` does, so an author can test it before it
 * is published. The checkout's own `node_modules` supplies tsx and the
 * browser driver.
 */
export async function resolveLocalLaunch(
  checkout: string,
  source: string,
): Promise<PdppLaunch> {
  const { files, profile } = await readLocalProfile(checkout, source);
  const key = source.toLowerCase();

  const cwd = findToolRoot(path.dirname(files.entry), files.root);
  if (!cwd) {
    throw new Error(
      `tsx is not installed in ${files.root}. Run npm install there first.`,
    );
  }
  let nodeRange = DEFAULT_NODE_RANGE;
  try {
    const pkg = JSON.parse(
      await fsp.readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    nodeRange = pkg.engines?.node ?? DEFAULT_NODE_RANGE;
  } catch {
    // No package.json at the tool root; keep the default.
  }

  return {
    source: key,
    displayName: profile.display_name ?? key,
    version: profile.version,
    profile,
    args: ["--import", "tsx", files.entry],
    cwd,
    nodeRange,
    installRoot: null,
    hostPackages: [],
    origin: "local",
  };
}
