import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireReceiptLock,
  ReceiptsStoreBusyError,
} from "../../src/core/receipts-lock.js";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-lock-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
it("retains an unidentified lock rather than adopting its payment state", () => {
  const lock = path.join(root, "state.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "unknown.json"), "invalid");
  expect(() => acquireReceiptLock(lock)).toThrow(ReceiptsStoreBusyError);
  expect(fs.readFileSync(path.join(lock, "unknown.json"), "utf8")).toBe(
    "invalid",
  );
});
it("a stale owner observation cannot delete a successor's live lock", () => {
  const lock = path.join(root, "state.lock");
  fs.mkdirSync(lock);
  const old = path.join(lock, "old.json");
  const successor = path.join(lock, "successor.json");
  fs.writeFileSync(old, JSON.stringify({ pid: 999999 }));
  const kill = process.kill;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === 999999)
      throw Object.assign(new Error("fixture: dead"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  const remove = fs.rmSync;
  vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (String(file) === old && fs.existsSync(old)) {
      fs.unlinkSync(old);
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
      fs.writeFileSync(successor, JSON.stringify({ pid: process.pid }));
    }
    return remove(file, options);
  });
  expect(() => acquireReceiptLock(lock)).toThrow(ReceiptsStoreBusyError);
  expect(JSON.parse(fs.readFileSync(successor, "utf8")).pid).toBe(process.pid);
});
