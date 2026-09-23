import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { getPdppHome } from "./host.js";
import type { ConnectorRecord, SkipResult } from "./protocol.js";

/**
 * What one connector has collected for one Personal Server owner: the
 * cursor per stream to resume from, and every record seen so far.
 *
 * The Personal Server replaces a scope on each write, while an incremental
 * run only returns what changed, so the full set has to be kept here and
 * sent every time. It is kept per owner so switching identities never
 * uploads one person's history into another's server.
 */
export interface CollectionState {
  version: 1;
  checkpoints: Record<string, Record<string, unknown>>;
  snapshot: Record<
    string,
    Array<{ key: string; data: Record<string, unknown> }>
  >;
}

function emptyState(): CollectionState {
  return { version: 1, checkpoints: {}, snapshot: {} };
}

export function ownerKey(owner: string | null | undefined): string {
  if (!owner) return "unowned";
  return `owner-${crypto.createHash("sha256").update(owner.toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function collectionStatePath(
  source: string,
  owner: string | null | undefined,
): string {
  return path.join(getPdppHome(), "state", source, `${ownerKey(owner)}.json`);
}

export async function readCollectionState(
  file: string,
): Promise<CollectionState> {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(file, "utf8"),
    ) as Partial<CollectionState>;
    if (parsed.version !== 1) return emptyState();
    return {
      version: 1,
      checkpoints: parsed.checkpoints ?? {},
      snapshot: parsed.snapshot ?? {},
    };
  } catch {
    return emptyState();
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, file);
}

/** Streams whose output this run can stand behind; a skip without a stream voids them all. */
export function completedStreams(
  requested: string[],
  skips: SkipResult[],
): string[] {
  if (skips.some((skip) => !skip.stream)) return [];
  const skipped = new Set(skips.map((skip) => skip.stream));
  return requested.filter((stream) => !skipped.has(stream));
}

/**
 * Fold a finished run into the stored state. Only completed streams change:
 * a skipped stream keeps its previous records and cursor, so a partial run
 * never erases what an earlier one collected.
 */
export function mergeRun(
  previous: CollectionState,
  run: {
    mode: "full_refresh" | "incremental";
    completed: string[];
    records: ConnectorRecord[];
    checkpoints: Record<string, Record<string, unknown>>;
  },
): CollectionState {
  const completed = new Set(run.completed);
  const snapshot: CollectionState["snapshot"] = { ...previous.snapshot };
  const checkpoints = { ...previous.checkpoints };

  const byStream = new Map<string, Map<string, Record<string, unknown>>>();
  for (const stream of completed) {
    const seed =
      run.mode === "full_refresh" ? [] : (previous.snapshot[stream] ?? []);
    byStream.set(stream, new Map(seed.map((entry) => [entry.key, entry.data])));
  }
  for (const record of run.records) {
    const entries = byStream.get(record.stream);
    if (!entries) continue;
    // Deleting and re-inserting moves an updated record to the end, matching
    // the order the connector last reported it in.
    entries.delete(record.key);
    if (record.op !== "delete") entries.set(record.key, record.data);
  }
  for (const [stream, entries] of byStream) {
    snapshot[stream] = [...entries].map(([key, data]) => ({ key, data }));
    if (run.checkpoints[stream]) checkpoints[stream] = run.checkpoints[stream];
  }
  return { version: 1, checkpoints, snapshot };
}

export async function writeCollectionState(
  file: string,
  state: CollectionState,
): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(state)}\n`);
}

/**
 * The result file the ingest step reads: one `<source>.<stream>` key per
 * completed stream, each an object wrapping every record the owner has, since
 * the Personal Server rejects array bodies.
 */
export function projectResult(
  source: string,
  displayName: string,
  state: CollectionState,
  completed: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    platform: source,
    company: displayName,
    exportedAt: new Date().toISOString(),
    completedStreams: completed,
  };
  for (const stream of completed) {
    result[`${source}.${stream}`] = {
      [stream]: (state.snapshot[stream] ?? []).map((entry) => entry.data),
    };
  }
  return result;
}

export async function writeResult(
  file: string,
  result: Record<string, unknown>,
): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(result, null, 2)}\n`);
}
