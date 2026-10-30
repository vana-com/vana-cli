import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getAccountUrl,
  loadAccountAddressForOwnership,
  loadPersonalServerSession,
  type VanaCredentials,
} from "./auth.js";
import { getVanaHome } from "../core/paths.js";

interface IdentityDisplay {
  address: string | null;
  email: string | null;
  name: string | null;
  loginMethod: string | null;
  accountUrl: string;
  expires_at: string | null;
  personalServerUrl: string | null;
  profileStatus: "available" | "cached" | "unavailable" | "not_requested";
}

/** Public owner identity; display metadata never establishes authentication. */
export type OwnerIdentity = IdentityDisplay &
  (
    | { authentication: "account"; authenticated: true }
    | { authentication: "personal_server" | "none"; authenticated: false }
  );

const profileSchema = z.object({
  email: z.string().nullable(),
  name: z.string().nullable(),
  loginMethod: z.string().nullable(),
});
type DisplayProfile = z.infer<typeof profileSchema>;
const bindingSchema = z.object({
  accountUrl: z.string(),
  address: z.string(),
  sessionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
type ProfileBinding = z.infer<typeof bindingSchema>;
const cacheSchema = z.object({
  version: z.literal(1),
  binding: bindingSchema,
  fetchedAt: z.iso.datetime(),
  profile: profileSchema,
});

function displayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return text || null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function profileCachePath(binding: ProfileBinding): string {
  return path.join(
    getVanaHome(),
    "identity-cache",
    `${digest(JSON.stringify(binding))}.json`,
  );
}

async function readProfileCache(
  binding: ProfileBinding,
): Promise<DisplayProfile | null> {
  try {
    const parsed = cacheSchema.parse(
      JSON.parse(await fs.readFile(profileCachePath(binding), "utf8")),
    );
    if (
      parsed.binding.accountUrl !== binding.accountUrl ||
      parsed.binding.address !== binding.address ||
      parsed.binding.sessionFingerprint !== binding.sessionFingerprint ||
      Date.parse(parsed.fetchedAt) > Date.now()
    ) {
      return null;
    }
    return {
      email: displayText(parsed.profile.email),
      name: displayText(parsed.profile.name),
      loginMethod: displayText(parsed.profile.loginMethod),
    };
  } catch {
    return null;
  }
}

async function writeProfileCache(
  binding: ProfileBinding,
  profile: DisplayProfile,
): Promise<void> {
  const file = profileCachePath(binding);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    await fs.writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        binding,
        fetchedAt: new Date().toISOString(),
        profile,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temporary, file);
  } catch {
    // A display cache must never prevent use of an existing login.
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Inspect the current login, optionally refreshing its display profile.
 * Status uses refresh:false so Account availability never delays inspection.
 * A separate cache cannot overwrite or resurrect authentication credentials.
 */
export async function queryOwnerIdentity(
  credentials: VanaCredentials | null,
  options: { refresh?: boolean } = {},
): Promise<OwnerIdentity> {
  const storedAccount = credentials?.account;
  const account =
    storedAccount?.session_token.trim() &&
    Date.parse(storedAccount.expires_at) > Date.now()
      ? storedAccount
      : null;
  const server = credentials?.personal_server ?? loadPersonalServerSession();
  const serverExpiry = server ? Date.parse(server.expires_at) : NaN;
  const hasServer = Boolean(
    server?.url &&
    server.session_token &&
    (!Number.isFinite(serverExpiry) || serverExpiry > Date.now()),
  );
  const identity: OwnerIdentity = {
    ...(account
      ? { authentication: "account" as const, authenticated: true as const }
      : {
          authentication: hasServer
            ? ("personal_server" as const)
            : ("none" as const),
          authenticated: false as const,
        }),
    address:
      account?.address ??
      (hasServer
        ? (storedAccount?.address ?? loadAccountAddressForOwnership())
        : null),
    email: null,
    name: null,
    loginMethod: null,
    accountUrl: getAccountUrl(),
    expires_at: account?.expires_at ?? null,
    personalServerUrl: hasServer ? server!.url : null,
    profileStatus: "not_requested",
  };
  if (!account) return identity;

  let binding: ProfileBinding | null = null;
  try {
    if (
      account.address.trim() &&
      account.address !== "env" &&
      account.address !== "vana-account"
    ) {
      binding = {
        accountUrl: new URL(identity.accountUrl).toString().replace(/\/+$/, ""),
        address: /^0x[a-f0-9]{40}$/i.test(account.address)
          ? account.address.toLowerCase()
          : account.address,
        sessionFingerprint: digest(account.session_token),
      };
    }
  } catch {
    // Invalid deployment configuration must not invalidate local identity.
  }
  const cached = binding ? await readProfileCache(binding) : null;
  if (cached) Object.assign(identity, cached, { profileStatus: "cached" });
  if (options.refresh === false) return identity;
  if (!cached) identity.profileStatus = "unavailable";
  try {
    const response = await fetch(`${identity.accountUrl}/userinfo`, {
      headers: { Authorization: `Bearer ${account.session_token}` },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return identity;
    const profile: unknown = await response.json();
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return identity;
    }
    const info = profile as Record<string, unknown>;
    const wallet = displayText(info.primary_wallet_address);
    if (
      wallet &&
      identity.address !== "env" &&
      wallet.toLowerCase() !== identity.address?.toLowerCase()
    ) {
      return identity;
    }
    const methods = Array.isArray(info.amr)
      ? info.amr.map(displayText).filter((method) => method !== null)
      : [];
    const display: DisplayProfile = {
      email: displayText(info.email),
      name: displayText(info.name) ?? displayText(info.display_name),
      loginMethod:
        displayText(info.login_method) ??
        displayText(info.auth_method) ??
        (methods.length ? methods.join(", ") : null),
    };
    Object.assign(identity, display, { profileStatus: "available" });
    if (binding) await writeProfileCache(binding, display);
  } catch {
    // Identity inspection remains usable when Account cannot be reached.
  }
  return identity;
}
