/**
 * Durable payment state for the builder read loop.
 *
 * Two responsibilities, one 0600 file (`~/.vana/app/receipts.json`):
 *
 * - Payment nonces per payer. The gateway rejects a reused (payer, nonce)
 *   pair, and the SDK's default nonce source is process-local seeded at 1,
 *   which breaks on the second CLI invocation. Nonces here only move
 *   forward.
 * - Receipts: the exact `X-PAYMENT` header (plus amount/asset metadata) of a
 *   settled read, keyed by network, grant, and scope. A later read replays
 *   the header first, so a retry after a failure never settles a second fee
 *   for data the app already paid for.
 */

import fs from "node:fs";
import path from "node:path";
import { getVanaHome } from "./paths.js";

export interface StoredReceipt {
  /** The signed X-PAYMENT header exactly as sent. */
  header: string;
  /** Base-unit decimal amount the header settles. */
  amount: string;
  /** Asset address (zero address = native VANA). */
  asset: string;
  /** ISO timestamp the CLI captured the header. */
  capturedAt: string;
  /** Payment metadata echoed by the Personal Server, when any. */
  payment?: Record<string, unknown>;
}

interface ReceiptsFile {
  version: 1;
  nonces: Record<string, string>;
  receipts: Record<string, StoredReceipt>;
}

const EMPTY: ReceiptsFile = { version: 1, nonces: {}, receipts: {} };

export function receiptKey(
  network: string,
  grantId: string,
  scope: string,
): string {
  return `${network}:${grantId.toLowerCase()}:${scope}`;
}

export interface ReceiptsStore {
  /** Next monotonically-increasing payment nonce for a payer; persisted. */
  nextNonce(payerAddress: string): bigint;
  getReceipt(key: string): StoredReceipt | null;
  saveReceipt(key: string, receipt: StoredReceipt): void;
  /** Drop a receipt the server refused (stale version, expired nonce). */
  dropReceipt(key: string): void;
}

export function createReceiptsStore(filePath?: string): ReceiptsStore {
  const file = filePath ?? path.join(getVanaHome(), "app", "receipts.json");

  function read(): ReceiptsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ReceiptsFile;
      if (parsed?.version !== 1) {
        return structuredClone(EMPTY);
      }
      return {
        version: 1,
        nonces: parsed.nonces ?? {},
        receipts: parsed.receipts ?? {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  function write(state: ReceiptsFile): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  return {
    nextNonce(payerAddress: string): bigint {
      const state = read();
      const key = payerAddress.toLowerCase();
      const next = BigInt(state.nonces[key] ?? "0") + 1n;
      state.nonces[key] = next.toString();
      write(state);
      return next;
    },
    getReceipt(key: string): StoredReceipt | null {
      return read().receipts[key] ?? null;
    },
    saveReceipt(key: string, receipt: StoredReceipt): void {
      const state = read();
      state.receipts[key] = receipt;
      write(state);
    },
    dropReceipt(key: string): void {
      const state = read();
      if (key in state.receipts) {
        delete state.receipts[key];
        write(state);
      }
    },
  };
}
