import crypto from "node:crypto";

import type { StoredSourceState } from "./state-store.js";

/** The Account deployment and wallet that collected an export; null is unknown. */
export type ExportOwner = { accountUrl: string; address: string } | null;

/** Accepted bytes and collection identity, independent of the current login. */
export interface SourceExportReceipt {
  version: 1;
  id: string;
  owner: ExportOwner;
  path: string;
  sha256: string;
}

/** Persisted receipts are untrusted; legacy or malformed records remain local. */
export function readExportReceipt(value: unknown): SourceExportReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Partial<SourceExportReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.id !== "string" ||
    !receipt.id ||
    typeof receipt.path !== "string" ||
    !receipt.path ||
    typeof receipt.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    return null;
  const owner = receipt.owner;
  if (
    owner !== null &&
    (!owner ||
      typeof owner.accountUrl !== "string" ||
      !owner.accountUrl ||
      typeof owner.address !== "string" ||
      !/^0x[a-f0-9]{40}$/i.test(owner.address))
  )
    return null;
  return receipt as SourceExportReceipt;
}

/** SHA-256 of the exact accepted bytes, before parsing or upload projection. */
export function exportDigest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Unknown identities never match, even when both exports are unattributed. */
export function sameExportOwner(a: ExportOwner, b: ExportOwner): boolean {
  return Boolean(
    a &&
    b &&
    a.accountUrl === b.accountUrl &&
    a.address.toLowerCase() === b.address.toLowerCase(),
  );
}

/** Failed and partially stored exports still occupy the accepted source slot. */
export function hasUnresolvedExport(
  source: StoredSourceState | undefined,
): boolean {
  return Boolean(
    source?.lastResultPath &&
    (source.dataState === "collected_local" ||
      source.dataState === "ingest_unavailable" ||
      source.dataState === "ingest_failed" ||
      source.ingestScopes?.some((scope) => scope.status === "failed")),
  );
}

/** A pending slot can only be replaced by its known collecting account. */
export function pendingExportBlockReason(
  source: StoredSourceState | undefined,
  selected: ExportOwner,
): string | null {
  if (!hasUnresolvedExport(source)) return null;
  const receipt = readExportReceipt(source?.exportReceipt);
  if (
    receipt &&
    receipt.path === source?.lastResultPath &&
    sameExportOwner(receipt.owner, selected)
  )
    return null;
  const location = `Kept locally at ${source?.lastResultPath}. Use \`vana data show\` to inspect it.`;
  if (!receipt?.owner || receipt.path !== source?.lastResultPath) {
    return `The pending export's collection account cannot be verified. Automatic sync and replacement are disabled. ${location}`;
  }
  return `Pending export belongs to Account ${receipt.owner.address} at ${receipt.owner.accountUrl}. ${location} Sign in to that collecting account and run \`vana server sync\`.`;
}
