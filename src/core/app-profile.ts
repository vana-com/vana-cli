/**
 * The name and homepage an app shows people during approval, remembered per
 * app address, environment and network. Historical address-only entries are
 * a read fallback; new writes never overwrite them or another network.
 * Two agents on one machine, each with its own VANA_APP_KEY, keep separate
 * names. Stored in `~/.vana/app/profile.json`; nothing here is secret.
 */

import fs from "node:fs";
import path from "node:path";
import { getVanaHome } from "./paths.js";
import { resolveNetwork, type ResolvedNetwork } from "./network.js";

/** How an app introduces itself on the approval page. */
export interface AppProfile {
  name?: string;
  url?: string;
}

function profilePath(): string {
  return path.join(getVanaHome(), "app", "profile.json");
}

function readAll(): Record<string, AppProfile> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(profilePath(), "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, AppProfile>)
      : {};
  } catch {
    return {};
  }
}

/** The remembered profile for an app address, or {} when none was saved. */
export function readAppProfile(
  address: string,
  network: ResolvedNetwork = resolveNetwork(),
): AppProfile {
  const all = readAll();
  return all[profileKey(address, network)] ?? all[address.toLowerCase()] ?? {};
}

function profileKey(address: string, network: ResolvedNetwork): string {
  return `${address.toLowerCase()}:${network.env}:${network.name}`;
}

/** Merge the given fields into the app's profile; empty input changes nothing. */
export function saveAppProfile(
  address: string,
  update: AppProfile,
  network: ResolvedNetwork = resolveNetwork(),
): void {
  const fields: AppProfile = {};
  if (update.name?.trim()) fields.name = update.name.trim();
  if (update.url?.trim()) fields.url = update.url.trim();
  if (!fields.name && !fields.url) return;
  const all = readAll();
  const key = profileKey(address, network);
  all[key] = { ...all[key], ...fields };
  fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
  // Write then rename, so a crash never leaves half a file behind.
  const temporary = `${profilePath()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, profilePath());
}
