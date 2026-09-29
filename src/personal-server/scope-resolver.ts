import type { ConnectorMetadata } from "../connectors/registry.js";

export interface ScopeMapping {
  scope: string;
  data: unknown;
}

/** Keys that are connector metadata, not user data. */
const EXCLUDED_KEYS = new Set([
  "exportSummary",
  "timestamp",
  "version",
  "platform",
]);

/**
 * Top-level metadata a Collection Profile (PDPP) result carries next to its
 * `<source>.<stream>` keys. `completedStreams` only appears in those results,
 * so it marks one.
 */
const PDPP_RESULT_MARKER = "completedStreams";

function isPdppResult(result: Record<string, unknown>): boolean {
  return Array.isArray(result[PDPP_RESULT_MARKER]);
}

/**
 * Ensure scope data is a JSON object for the Personal Server API.
 * Arrays are wrapped as `{ items: [...] }`. Primitives are wrapped
 * as `{ value: ... }`. Objects pass through unchanged.
 */
function ensureObject(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return { items: data };
  }
  if (data !== null && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

function normalizeScopeSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function normalizeScope(scope: string): string {
  return scope.split(".").filter(Boolean).map(normalizeScopeSegment).join(".");
}

/**
 * Resolve connector output keys to personal server scopes.
 *
 * Strategy (matches DataConnect production):
 * 1. If any output keys contain ".", use them directly as scopes
 * 2. Otherwise, use connector metadata to map: metadata scope "github.profile"
 *    → look for key "profile" in result
 * 3. If no metadata, fall back to "{source}.{key}" for every non-metadata key
 *    (exclude: exportSummary, timestamp, version, platform)
 *
 * A PDPP result (one carrying a `completedStreams` array) only ever resolves
 * through strategy 1; with no dotted keys it resolves to nothing.
 *
 * @param source - The connector source name (e.g. "github")
 * @param result - The connector output as key-value pairs
 * @param metadata - Optional connector metadata with scope definitions
 * @returns An array of scope mappings
 */
export function resolveScopes(
  source: string,
  result: Record<string, unknown>,
  metadata: ConnectorMetadata | null,
): ScopeMapping[] {
  const keys = Object.keys(result);

  // Strategy 1: If any keys are already dotted scopes, use them directly.
  const dottedKeys = keys.filter(
    (key) => key.includes(".") && !EXCLUDED_KEYS.has(key),
  );
  if (dottedKeys.length > 0) {
    return dottedKeys.map((key) => ({
      scope: normalizeScope(key),
      data: ensureObject(result[key]),
    }));
  }

  // A PDPP result names its scopes as dotted keys and nothing else. Without
  // any, no stream completed, and its metadata (company, exportedAt,
  // completedStreams) must never fall through to become scopes.
  if (isPdppResult(result)) return [];

  // Strategy 2: Use metadata scopes to map flat keys.
  if (metadata?.scopes && metadata.scopes.length > 0) {
    const mappings: ScopeMapping[] = [];
    for (const { scope } of metadata.scopes) {
      // Extract the key portion after the dot, e.g. "github.profile" → "profile"
      const dotIndex = scope.indexOf(".");
      const key = dotIndex >= 0 ? scope.slice(dotIndex + 1) : scope;
      if (key in result) {
        mappings.push({
          scope: normalizeScope(scope),
          data: ensureObject(result[key]),
        });
      }
    }
    return mappings;
  }

  // Strategy 3: Fall back to "{source}.{key}" for every non-metadata key.
  return keys
    .filter((key) => !EXCLUDED_KEYS.has(key))
    .map((key) => ({
      scope: normalizeScope(`${source}.${key}`),
      data: ensureObject(result[key]),
    }));
}
