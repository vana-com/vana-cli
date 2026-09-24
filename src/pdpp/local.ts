import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { parseCollectionProfile, type PdppLaunch } from "./profile.js";

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

/**
 * Run a connector from a data-connectors checkout instead of a signed
 * artifact, the way `connector-dev` does, so an author can test it before it
 * is published.
 *
 * Both layouts are accepted: connectors at the repository root
 * (`connectors/<key>/index.ts` with `connectors/<key>/manifest.json`), and
 * the earlier `packages/polyfill-connectors/connectors/<key>/index.ts` with
 * `manifests/<key>.json`. The checkout's own `node_modules` supplies tsx and
 * the browser driver.
 */
export async function resolveLocalLaunch(
  checkout: string,
  source: string,
): Promise<PdppLaunch> {
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
    const profile = parseCollectionProfile(
      JSON.parse(await fsp.readFile(manifestPath, "utf8")),
      manifestPath,
    );

    const cwd = findToolRoot(path.dirname(entry), root);
    if (!cwd) {
      throw new Error(
        `tsx is not installed in ${root}. Run npm install there first.`,
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
      args: ["--import", "tsx", entry],
      cwd,
      nodeRange,
      installRoot: null,
      hostPackages: [],
      origin: "local",
    };
  }

  throw new Error(
    `No connector named ${key} in ${root}. Looked for connectors/${key}/index.ts at the root and under packages/polyfill-connectors.`,
  );
}
