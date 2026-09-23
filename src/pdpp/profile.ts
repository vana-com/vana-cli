/** The parts of a Collection Profile manifest a host reads. */
export interface CollectionProfileStream {
  name: string;
  required?: boolean;
  incremental?: boolean;
  display?: { label?: string };
}

export interface CollectionProfile {
  connector_key: string;
  version: string;
  display_name?: string;
  streams: CollectionProfileStream[];
  capabilities?: { human_interaction?: string[] };
  runtime_requirements?: {
    bindings?: { browser?: { required?: boolean } };
  };
}

/**
 * How to start one connector: the program arguments after `node`, where to
 * run them, and what the host has to provide first.
 */
export interface PdppLaunch {
  source: string;
  displayName: string;
  version: string;
  profile: CollectionProfile;
  args: string[];
  cwd: string;
  /** Node range from provenance; the connector refuses to run outside it. */
  nodeRange: string;
  /** Where host packages get linked, or null when the source tree has its own. */
  installRoot: string | null;
  hostPackages: Array<{ package: string; declared_version: string }>;
  /** `pinned` runs a verified artifact; `local` runs a checkout's source. */
  origin: "pinned" | "local";
}

export function parseCollectionProfile(
  raw: unknown,
  where: string,
): CollectionProfile {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${where} is not a Collection Profile manifest.`);
  }
  const value = raw as Record<string, unknown>;
  const streams = Array.isArray(value.streams) ? value.streams : [];
  if (
    typeof value.connector_key !== "string" ||
    typeof value.version !== "string" ||
    streams.length === 0 ||
    !streams.every(
      (stream) =>
        stream &&
        typeof stream === "object" &&
        typeof (stream as Record<string, unknown>).name === "string",
    )
  ) {
    throw new Error(
      `${where} is missing connector_key, version or named streams.`,
    );
  }
  return value as unknown as CollectionProfile;
}
