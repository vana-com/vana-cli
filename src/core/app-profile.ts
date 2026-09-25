/**
 * The name and homepage an app shows people during approval, remembered per
 * app address so `vana app request` does not need `--app-name` every time.
 * Two agents on one machine, each with its own VANA_APP_KEY, keep separate
 * names. Stored in `~/.vana/app/profile.json`; nothing here is secret.
 */

import fs from "node:fs";
import path from "node:path";
import { getVanaHome } from "./paths.js";

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

export function readAppProfile(address: string): AppProfile {
  return readAll()[address.toLowerCase()] ?? {};
}

/** Merge the given fields into the app's profile; empty input changes nothing. */
export function saveAppProfile(address: string, update: AppProfile): void {
  const fields: AppProfile = {};
  if (update.name?.trim()) fields.name = update.name.trim();
  if (update.url?.trim()) fields.url = update.url.trim();
  if (!fields.name && !fields.url) return;
  const all = readAll();
  const key = address.toLowerCase();
  all[key] = { ...all[key], ...fields };
  fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
  fs.writeFileSync(profilePath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
}
