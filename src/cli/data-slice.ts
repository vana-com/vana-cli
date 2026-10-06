/**
 * Read a collected connector result in bounded pieces.
 *
 * A result file can be tens of megabytes (a ChatGPT export with thousands of
 * conversations), far past what an agent can take in one tool result. These
 * helpers describe a result by scope (item counts and byte sizes) and page
 * through one scope's items with an optional text filter, never returning
 * more than a fixed number of bytes.
 *
 * Pure functions over the parsed result; no file or terminal access.
 */

/** Top-level keys that describe a run rather than hold collected data. */
export const RESULT_METADATA_KEYS = new Set([
  "requestedScopes",
  "timestamp",
  "version",
  "platform",
  "exportSummary",
  "errors",
  // Collection Profile (PDPP) results
  "company",
  "exportedAt",
  "completedStreams",
]);

/** Scalar keys a connector puts next to its list (`{ items, total }`). */
function isCounterValue(value: unknown): boolean {
  return (
    typeof value === "number" || typeof value === "boolean" || value === null
  );
}

/** The last segment of a scope key, `github.repositories` -> `repositories`. */
export function scopeLeaf(scope: string): string {
  const parts = scope.split(".");
  return parts[parts.length - 1] ?? scope;
}

/**
 * The list of items a scope holds, or null when it holds one record.
 *
 * Connectors write a scope three ways: a bare array, a wrapper named after
 * the stream (`{ messages: [...] }`, `{ conversations: [...], total: 3 }`),
 * or a single record such as a profile.
 */
export function scopeList(scope: string, value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const named = record[scopeLeaf(scope)];
  if (Array.isArray(named)) return named;
  const entries = Object.entries(record);
  const arrays = entries.filter(([, entry]) => Array.isArray(entry));
  if (
    arrays.length === 1 &&
    entries.every(([, entry]) => Array.isArray(entry) || isCounterValue(entry))
  ) {
    return arrays[0][1] as unknown[];
  }
  return null;
}

export interface ScopeOverview {
  scope: string;
  /** "list" pages by item; "record" is one object returned whole. */
  kind: "list" | "record";
  items: number;
  bytes: number;
}

/** Data-bearing keys of a result, in file order. */
export function dataScopeKeys(data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => !RESULT_METADATA_KEYS.has(key));
}

export function describeScopes(data: Record<string, unknown>): ScopeOverview[] {
  return dataScopeKeys(data).map((scope) => {
    const value = data[scope];
    const list = scopeList(scope, value);
    return {
      scope,
      kind: list ? "list" : "record",
      items: list ? list.length : 1,
      bytes: byteLength(JSON.stringify(value) ?? ""),
    };
  });
}

/**
 * Match a requested scope to a key in the result. Accepts the exact key
 * (`github.repositories`) or its last segment (`repositories`).
 */
export function resolveScopeKey(
  data: Record<string, unknown>,
  requested: string,
): string | null {
  const keys = dataScopeKeys(data);
  if (keys.includes(requested)) return requested;
  const lower = requested.toLowerCase();
  const exact = keys.find((key) => key.toLowerCase() === lower);
  if (exact) return exact;
  const byLeaf = keys.filter((key) => scopeLeaf(key).toLowerCase() === lower);
  return byLeaf.length === 1 ? byLeaf[0] : null;
}

export const DEFAULT_SLICE_LIMIT = 20;
export const MAX_SLICE_LIMIT = 500;
/** Hard cap on the serialized items in one slice. */
export const DEFAULT_SLICE_MAX_BYTES = 100_000;

export interface SliceOptions {
  scope: string;
  offset?: number;
  limit?: number;
  query?: string;
  maxBytes?: number;
}

export interface DataSlice {
  scope: string;
  kind: "list" | "record";
  /** Items in the scope, before the query filter. */
  total: number;
  /** Items that match `query` (equals `total` without one). */
  matched: number;
  query: string | null;
  offset: number;
  returned: number;
  /** Offset to pass for the next page, or null when this is the last. */
  nextOffset: number | null;
  /** True when the byte cap cut the page short or shortened an item. */
  truncated: boolean;
  note: string;
  items: unknown[];
}

export class UnknownScopeError extends Error {
  constructor(
    readonly requested: string,
    readonly available: string[],
  ) {
    super(
      `No scope "${requested}" in this dataset. Available scopes: ${available.join(", ") || "(none)"}.`,
    );
    this.name = "UnknownScopeError";
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function itemBytes(preview: unknown): number {
  return (preview as { bytes: number }).bytes;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a char. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

/**
 * One page of a scope's items. Items are filtered by `query`
 * (case-insensitive substring over each item's JSON), then paged by
 * `offset`/`limit`, then cut so the page stays under `maxBytes`. A single
 * item larger than the cap comes back as a truncated JSON preview.
 */
export function sliceScope(
  data: Record<string, unknown>,
  options: SliceOptions,
): DataSlice {
  const scope = resolveScopeKey(data, options.scope);
  if (!scope) {
    throw new UnknownScopeError(options.scope, dataScopeKeys(data));
  }
  const value = data[scope];
  const list = scopeList(scope, value);
  const kind = list ? "list" : "record";
  const all = list ?? [value];
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(
    MAX_SLICE_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_SLICE_LIMIT)),
  );
  const maxBytes = options.maxBytes ?? DEFAULT_SLICE_MAX_BYTES;
  const query = options.query?.trim() ? options.query.trim() : null;
  const needle = query?.toLowerCase();

  const matches = needle
    ? all.filter((item) =>
        (JSON.stringify(item) ?? "").toLowerCase().includes(needle),
      )
    : all;

  const page = matches.slice(offset, offset + limit);
  const items: unknown[] = [];
  let used = 0;
  let truncated = false;
  let previewed = false;
  for (const item of page) {
    const text = JSON.stringify(item) ?? "null";
    const size = byteLength(text);
    if (used + size <= maxBytes) {
      items.push(item);
      used += size;
      continue;
    }
    truncated = true;
    if (items.length === 0) {
      previewed = true;
      // A single item over the cap: hand back a readable prefix rather
      // than nothing, so the page still advances.
      items.push({
        _truncated: true,
        bytes: size,
        preview: truncateUtf8(text, maxBytes),
      });
    }
    break;
  }

  const end = offset + items.length;
  const nextOffset = end < matches.length ? end : null;
  const notes: string[] = [];
  if (matches.length === 0) {
    notes.push(
      query ? `No items in ${scope} match "${query}".` : `${scope} is empty.`,
    );
  } else if (items.length === 0) {
    notes.push(
      `Offset ${offset} is past the last item (${matches.length} ${query ? "matching" : "total"}).`,
    );
  } else {
    notes.push(
      `Items ${offset}-${end - 1} of ${matches.length}${query ? ` matching "${query}"` : ""}.`,
    );
  }
  if (truncated) {
    notes.push(
      previewed
        ? `The item at offset ${offset} is ${Math.round(itemBytes(items[0]) / 1000)} KB, over the ${Math.round(maxBytes / 1000)} KB cap, so it comes back as a truncated JSON preview.`
        : `Cut short to stay under ${Math.round(maxBytes / 1000)} KB.`,
    );
  }
  if (nextOffset !== null) {
    notes.push(
      `More remain: call show_data again with scope "${scope}" and offset ${nextOffset}${query ? ` and the same query` : ""}.`,
    );
  }

  return {
    scope,
    kind,
    total: all.length,
    matched: matches.length,
    query,
    offset,
    returned: items.length,
    nextOffset,
    truncated,
    note: notes.join(" "),
    items,
  };
}
