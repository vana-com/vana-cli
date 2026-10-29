import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getVanaHome } from "./paths.js";

const registrationSchema = z.object({
  appAddress: z.string(),
  subject: z.string(),
  accountUrl: z.string().url(),
  gatewayUrl: z.string().url(),
  network: z.literal("mainnet"),
  env: z.literal("prod"),
  appUrl: z.string().url(),
  appName: z.string().max(64),
});

/** Nonsecret identity retained until registration and Account association agree. */
export type StoredAppRegistration = z.infer<typeof registrationSchema>;

/** Another process owns this registration journal. */
export class AppRegistrationStoreBusyError extends Error {}

/** Frozen registration identity, independent of consent and funding setup. */
export interface AppRegistrationStore {
  getRegistration(): StoredAppRegistration | null;
  saveRegistration(registration: StoredAppRegistration): void;
  completeRegistration(registration: StoredAppRegistration): void;
}

/** Retain one unfinished transition without storing keys or Account tokens. */
export function createAppRegistrationStore(
  filePath?: string,
): AppRegistrationStore {
  const file = filePath ?? path.join(getVanaHome(), "app", "registration.json");
  function withWriteLock<T>(mutate: () => T): T {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const token = `${randomUUID()}.json`;
    const prepared = `${lock}.${randomUUID()}.tmp`;
    fs.mkdirSync(prepared, { mode: 0o700 });
    let acquired = false;
    const removeEmptyLock = () => {
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
        { flag: "wx", mode: 0o600 },
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          fs.renameSync(prepared, lock);
          acquired = true;
          break;
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
            if (owners.length === 0) {
              removeEmptyLock();
              continue;
            }
            if (owners.length !== 1) throw new Error("Invalid lock owners");
            pid = z
              .object({ pid: z.number().int().positive() })
              .parse(
                JSON.parse(fs.readFileSync(path.join(lock, owners[0]), "utf8")),
              ).pid;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new AppRegistrationStoreBusyError(
              "Cannot identify the registration journal's writer.",
            );
          }
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              throw new AppRegistrationStoreBusyError(
                "Another command is updating registration state.",
              );
            try {
              fs.unlinkSync(path.join(lock, owners[0]));
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
                throw unlinkError;
            }
            // A successor's owner file makes this fail harmlessly with
            // ENOTEMPTY, even if it acquired the lock after the stale read.
            removeEmptyLock();
            continue;
          }
          throw new AppRegistrationStoreBusyError(
            "Another command is updating registration state.",
          );
        }
      }
      if (!acquired)
        throw new AppRegistrationStoreBusyError(
          "Cannot lock registration state.",
        );
      return mutate();
    } finally {
      try {
        if (acquired) {
          fs.unlinkSync(path.join(lock, token));
          removeEmptyLock();
        }
      } finally {
        fs.rmSync(prepared, { recursive: true, force: true });
      }
    }
  }

  function read(): StoredAppRegistration | null {
    try {
      return registrationSchema.parse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  function write(state: StoredAppRegistration): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      if (process.platform !== "win32") {
        const fd = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  return {
    getRegistration: read,
    saveRegistration(registration) {
      withWriteLock(() => {
        const parsed = registrationSchema.parse(registration);
        const saved = read();
        if (saved && JSON.stringify(saved) !== JSON.stringify(parsed))
          throw new Error(
            "An unfinished registration has a different app, Account, network or URL. Resume its original context.",
          );
        write(parsed);
      });
    },
    completeRegistration(registration) {
      withWriteLock(() => {
        const saved = read();
        if (
          saved &&
          JSON.stringify(saved) ===
            JSON.stringify(registrationSchema.parse(registration))
        )
          fs.unlinkSync(file);
      });
    },
  };
}
