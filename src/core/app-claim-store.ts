import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getVanaHome } from "./paths.js";

const claimSchema = z.object({
  address: z.string().regex(/^0x[a-f0-9]{40}$/),
  accountUrl: z.string().url(),
  gatewayUrl: z.string().url(),
  network: z.enum(["moksha", "mainnet"]),
  subject: z.string().regex(/^vana_user_[a-f0-9]{32}$/),
  appName: z.string(),
  link: z
    .object({ url: z.string().url(), expiry: z.number().int() })
    .optional(),
});

/** Claim identity and browser handoff retained across CLI invocations. */
export type StoredAppClaim = z.infer<typeof claimSchema>;
type ClaimContext = Pick<
  StoredAppClaim,
  "address" | "accountUrl" | "gatewayUrl" | "network"
>;

/** Keep claim recovery separate from funding and consent journals. */
export function createAppClaimStore(context: ClaimContext) {
  const id = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const file = path.join(getVanaHome(), "app", "claims", `${id}.json`);
  return {
    read(): StoredAppClaim | null {
      try {
        const saved = claimSchema.parse(
          JSON.parse(fs.readFileSync(file, "utf8")),
        );
        if (
          Object.entries(context).some(
            ([key, value]) => saved[key as keyof ClaimContext] !== value,
          )
        ) {
          throw new Error(
            "Saved claim context does not match this app and environment.",
          );
        }
        return saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    save(claim: StoredAppClaim): void {
      const saved = claimSchema.parse(claim);
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(saved)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}
