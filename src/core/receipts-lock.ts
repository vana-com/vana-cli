import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** A live or unidentified process owns the payment state being changed. */
export class ReceiptsStoreBusyError extends Error {}

/** Publish an identified owner atomically; reclaim only a demonstrably dead one. */
export function acquireReceiptLock(lock: string): () => void {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = `${randomUUID()}.json`;
  const prepared = `${lock}.${randomUUID()}.tmp`;
  fs.mkdirSync(prepared, { mode: 0o700 });
  const removeEmpty = () => {
    try {
      fs.rmdirSync(lock);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  };
  try {
    fs.writeFileSync(
      path.join(prepared, token),
      JSON.stringify({ pid: process.pid }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.renameSync(prepared, lock);
        return () => {
          fs.rmSync(path.join(lock, token), { force: true });
          removeEmpty();
        };
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        let owners: string[];
        let pid: number;
        try {
          owners = fs.readdirSync(lock);
          if (!owners.length) {
            removeEmpty();
            continue;
          }
          if (owners.length !== 1)
            throw new Error("Invalid payment lock owners");
          pid = z
            .object({ pid: z.number().int().positive() })
            .parse(
              JSON.parse(fs.readFileSync(path.join(lock, owners[0]), "utf8")),
            ).pid;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new ReceiptsStoreBusyError(
            "Cannot identify the process using payment state.",
          );
        }
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw new ReceiptsStoreBusyError(
              "Another command is using payment state.",
            );
          }
          fs.rmSync(path.join(lock, owners[0]), { force: true });
          removeEmpty();
          continue;
        }
        throw new ReceiptsStoreBusyError(
          "Another command is using payment state.",
        );
      }
    }
    throw new ReceiptsStoreBusyError("Cannot lock payment state.");
  } finally {
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}
