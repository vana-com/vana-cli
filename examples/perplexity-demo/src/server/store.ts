import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface Thread {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

export interface Connection {
  requestId: string;
  appAddress: string;
  environment: string;
  binding?: { grantId: string; owner: string; serverUrl: string };
  saved?: { revision: string; savedAt: string; threads: Thread[] };
  acknowledged?: string;
}

/** Private local demo storage. The browser holds only an opaque capability. */
export class ShelfStore {
  constructor(private readonly directory: string) {}

  private file(token: string): string {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid session");
    return path.join(
      this.directory,
      `${createHash("sha256").update(token).digest("hex")}.json`,
    );
  }

  async read<T = Connection>(token: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.file(token), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(token: string, state: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(token);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  }

  /** Serialize spending and saves across route workers; busy callers fail closed. */
  async exclusive<T>(token: string, run: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.file(token)}.lock`;
    const owner = await open(lock, "wx", 0o600);
    try {
      await owner.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      await owner.sync();
      return await run();
    } finally {
      await owner.close();
      await rm(lock);
    }
  }
}
