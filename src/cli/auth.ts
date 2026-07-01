/**
 * Credential management for Vana CLI authentication.
 *
 * Stores and retrieves auth credentials from ~/.vana/auth.json.
 * Supports the device code flow for browser-based login and
 * env var overrides for CI/automation.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface VanaCredentials {
  account: {
    address: string;
    session_token: string;
    expires_at: string;
  };
  personal_server: {
    url: string;
    session_token: string;
    expires_at: string;
  } | null;
}

interface LegacyVanaCredentials {
  account: VanaCredentials["account"];
  personal_server: {
    url: string;
    access_token?: string;
    session_token?: string;
    expires_at: string;
  } | null;
}

const AUTH_FILE = "auth.json";

function getAuthFilePath(): string {
  return path.join(os.homedir(), ".vana", AUTH_FILE);
}

function normalizeCredentials(
  creds: LegacyVanaCredentials,
): VanaCredentials | null {
  if (!creds.account || typeof creds.account.session_token !== "string") {
    return null;
  }

  const personalServer = creds.personal_server;

  return {
    account: creds.account,
    personal_server: personalServer
      ? {
          url: personalServer.url,
          session_token:
            personalServer.session_token ?? personalServer.access_token ?? "",
          expires_at: personalServer.expires_at,
        }
      : null,
  };
}

/**
 * Load credentials from disk or env vars.
 *
 * Priority:
 * 1. Env vars (VANA_SESSION_TOKEN, VANA_PS_TOKEN, VANA_PS_URL)
 * 2. File (~/.vana/auth.json)
 *
 * Returns null if no credentials are available or if they are expired.
 */
export function loadCredentials(): VanaCredentials | null {
  // Check env var overrides first
  const envSessionToken = process.env.VANA_SESSION_TOKEN;
  const envPsToken = process.env.VANA_PS_TOKEN;
  const envPsUrl =
    process.env.VANA_PS_URL ?? process.env.VANA_PERSONAL_SERVER_URL;

  if (envSessionToken) {
    // Build credentials from env vars — no expiry tracking for env-based tokens
    const farFuture = new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    return {
      account: {
        address: "env",
        session_token: envSessionToken,
        expires_at: farFuture,
      },
      personal_server:
        envPsToken && envPsUrl
          ? {
              url: envPsUrl,
              session_token: envPsToken,
              expires_at: farFuture,
            }
          : null,
    };
  }

  // Read from file
  const filePath = getAuthFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const creds = normalizeCredentials(
      JSON.parse(raw) as LegacyVanaCredentials,
    );
    if (!creds) {
      return null;
    }
    if (isExpired(creds)) {
      return null;
    }
    return creds;
  } catch {
    return null;
  }
}

/**
 * Save credentials to ~/.vana/auth.json with 0600 permissions.
 */
export async function saveCredentials(creds: VanaCredentials): Promise<void> {
  const filePath = getAuthFilePath();
  const dir = path.dirname(filePath);

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Delete ~/.vana/auth.json.
 */
export async function clearCredentials(): Promise<void> {
  const filePath = getAuthFilePath();
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    // Ignore if file doesn't exist
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Check if the account session token has expired.
 */
export function isExpired(creds: VanaCredentials): boolean {
  try {
    const expiresAt = new Date(creds.account.expires_at);
    return expiresAt.getTime() <= Date.now();
  } catch {
    return true;
  }
}

/**
 * Format an address for display: 0x2Ab3...fa1
 */
export function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-3)}`;
}

function isWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Return human-readable time until expiry: "29 days", "3 hours", etc.
 */
export function formatExpiresIn(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;

  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"}`;

  const minutes = Math.floor(ms / (60 * 1000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// ── Device code flow ───────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceCodePollAuthorized {
  status: "authorized";
  session_token: string;
  personal_server_url?: string;
  personal_server_session_token?: string;
  ps_access_token?: string;
  address: string;
  expires_in?: number;
  expires_at?: string;
}

export interface DeviceCodePollPending {
  status: "pending";
}

export interface DeviceCodePollSlowDown {
  status: "slow_down";
}

export interface DeviceCodePollExpired {
  status: "expired";
}

export type DeviceCodePollResponse =
  | DeviceCodePollAuthorized
  | DeviceCodePollPending
  | DeviceCodePollSlowDown
  | DeviceCodePollExpired;

export interface DeviceCodeFlowOptions {
  clientId?: string;
}

interface DeviceCodeFlowCallbacks {
  onCode: (code: string, verificationUri: string) => void;
  onWaiting: () => void;
  onAuthorized: (creds: VanaCredentials) => void | Promise<void>;
  onExpired: () => void;
  onError: (error: Error) => void;
}

interface OidcDiscoveryDocument {
  device_authorization_endpoint?: unknown;
  token_endpoint?: unknown;
}

interface OAuthDeviceEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

interface OAuthTokenSuccess {
  access_token: string;
  address?: string;
  expires_at?: string;
  expires_in?: number;
  id_token?: string;
  personal_server_session_token?: string;
  personal_server_url?: string;
  ps_access_token?: string;
}

interface OAuthTokenError {
  error?: string;
  error_description?: string;
}

interface StartedDeviceCodeFlow {
  deviceCode: DeviceCodeResponse;
  kind: "legacy" | "oauth";
  poll: () => Promise<DeviceCodePollResponse>;
  verificationUri: string;
}

const OAUTH_DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_OAUTH_SCOPE = "openid profile offline_access";

function resolveCredentialExpiry(params: {
  expiresAt?: string;
  expiresIn?: number;
}): string {
  if (params.expiresAt) {
    const parsed = new Date(params.expiresAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const expiresIn = params.expiresIn ?? 30 * 24 * 60 * 60;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function getAccountUrl(): string {
  return (
    process.env.VANA_ACCOUNT_URL?.replace(/\/+$/, "") ??
    "https://account.vana.org"
  );
}

export function resolveOAuthClientId(accountUrl = getAccountUrl()): string {
  const configured =
    process.env.VANA_OAUTH_CLIENT_ID ?? process.env.VANA_ACCOUNT_CLIENT_ID;
  if (configured?.trim()) {
    return configured.trim();
  }

  try {
    const hostname = new URL(accountUrl).hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.includes("account-dev")
    ) {
      return "vana-cli-dev";
    }
  } catch {
    // Fall through to the production client id.
  }

  return "vana-cli";
}

/**
 * Request a device code from the auth server.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const url = `${getAccountUrl()}/api/auth/device`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to start device code flow: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Poll for device code authorization.
 */
export async function pollDeviceCode(
  deviceCode: string,
): Promise<DeviceCodePollResponse> {
  const url = `${getAccountUrl()}/api/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`;
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Poll failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
    );
  }

  return (await response.json()) as DeviceCodePollResponse;
}

async function discoverOAuthDeviceEndpoints(
  accountUrl: string,
): Promise<OAuthDeviceEndpoints | null> {
  try {
    const response = await fetch(
      `${accountUrl}/.well-known/openid-configuration`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    const doc = (await response.json()) as OidcDiscoveryDocument;
    if (
      typeof doc.device_authorization_endpoint !== "string" ||
      typeof doc.token_endpoint !== "string"
    ) {
      return null;
    }
    return {
      deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
    };
  } catch {
    return null;
  }
}

async function requestOAuthDeviceCode(
  endpoint: string,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: process.env.VANA_OAUTH_SCOPE ?? DEFAULT_OAUTH_SCOPE,
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const detail = await readOAuthErrorDetail(response);
    throw new Error(
      `Failed to start OAuth device flow: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

async function pollOAuthDeviceCode(params: {
  clientId: string;
  deviceCode: string;
  tokenEndpoint: string;
}): Promise<DeviceCodePollResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    device_code: params.deviceCode,
    grant_type: OAUTH_DEVICE_CODE_GRANT,
  });
  const response = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const raw = (await response.json().catch(() => ({}))) as unknown;
  const parsed =
    raw && typeof raw === "object"
      ? (raw as OAuthTokenSuccess | OAuthTokenError)
      : {};

  if (response.ok && "access_token" in parsed) {
    return oauthTokenToAuthorized(parsed);
  }

  const errorBody = parsed as OAuthTokenError;
  const oauthError =
    typeof errorBody.error === "string" ? errorBody.error : "unknown_error";
  if (oauthError === "authorization_pending") {
    return { status: "pending" };
  }
  if (oauthError === "slow_down") {
    return { status: "slow_down" };
  }
  if (oauthError === "expired_token") {
    return { status: "expired" };
  }

  const description =
    typeof errorBody.error_description === "string"
      ? errorBody.error_description
      : oauthError;
  throw new Error(`OAuth device authorization failed: ${description}`);
}

function oauthTokenToAuthorized(
  token: OAuthTokenSuccess,
): DeviceCodePollAuthorized {
  return {
    status: "authorized",
    address: resolveOAuthAccountAddress(token),
    session_token: token.access_token,
    expires_at: token.expires_at,
    expires_in: token.expires_in,
    personal_server_url: token.personal_server_url,
    personal_server_session_token: token.personal_server_session_token,
    ps_access_token: token.ps_access_token,
  };
}

async function readOAuthErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as OAuthTokenError;
    return parsed.error_description ?? parsed.error ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function resolveOAuthAccountAddress(token: OAuthTokenSuccess): string {
  if (token.address) {
    return token.address;
  }
  const claims = decodeJwtClaims(token.id_token);
  for (const key of ["wallet_address", "wallet", "eth_address", "address"]) {
    const value = claims?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const sub = claims?.sub;
  if (typeof sub === "string" && isWalletAddress(sub)) {
    return sub;
  }
  return "vana-account";
}

function decodeJwtClaims(
  idToken: string | undefined,
): Record<string, unknown> | null {
  if (!idToken) {
    return null;
  }
  const [, payload] = idToken.split(".");
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

async function startDeviceCodeFlow(
  options: DeviceCodeFlowOptions,
): Promise<StartedDeviceCodeFlow> {
  const accountUrl = getAccountUrl();
  const endpoints = await discoverOAuthDeviceEndpoints(accountUrl);
  if (endpoints) {
    const clientId = options.clientId ?? resolveOAuthClientId(accountUrl);
    const deviceCode = await requestOAuthDeviceCode(
      endpoints.deviceAuthorizationEndpoint,
      clientId,
    );
    return {
      deviceCode,
      kind: "oauth",
      poll: () =>
        pollOAuthDeviceCode({
          clientId,
          deviceCode: deviceCode.device_code,
          tokenEndpoint: endpoints.tokenEndpoint,
        }),
      verificationUri:
        deviceCode.verification_uri_complete ?? deviceCode.verification_uri,
    };
  }

  const deviceCode = await requestDeviceCode();
  return {
    deviceCode,
    kind: "legacy",
    poll: () => pollDeviceCode(deviceCode.device_code),
    verificationUri: deviceCode.verification_uri,
  };
}

/**
 * Open a URL in the user's default browser.
 * Best-effort — failures are silently ignored.
 */
export function openBrowser(url: string): void {
  // Use spawnSync with args array to prevent shell injection.
  // A malicious server could return a URL with shell metacharacters.
  const platform = process.platform;

  try {
    const opener =
      platform === "darwin"
        ? "open"
        : platform === "win32"
          ? "start"
          : "xdg-open";
    spawnSync(opener, [url], { stdio: "ignore" });
  } catch {
    // Best-effort — user can open manually
  }
}

/**
 * Run the full device code login flow.
 *
 * Returns credentials on success, or null if the code expired.
 * Calls the provided callbacks for UI updates.
 */
export async function runDeviceCodeFlow(
  callbacks: DeviceCodeFlowCallbacks,
  options: DeviceCodeFlowOptions = {},
): Promise<VanaCredentials | null> {
  try {
    const flow = await startDeviceCodeFlow(options);
    const { deviceCode } = flow;

    callbacks.onCode(deviceCode.user_code, flow.verificationUri);

    // Try to open browser
    openBrowser(flow.verificationUri);

    callbacks.onWaiting();

    let interval = (deviceCode.interval ?? 5) * 1000;
    const deadline = Date.now() + deviceCode.expires_in * 1000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      try {
        const result = await flow.poll();

        if (result.status === "authorized") {
          const expiresAt = resolveCredentialExpiry({
            expiresAt: result.expires_at,
            expiresIn: result.expires_in,
          });

          const creds: VanaCredentials = {
            account: {
              address: result.address,
              session_token: result.session_token,
              expires_at: expiresAt,
            },
            personal_server:
              result.personal_server_url &&
              (result.personal_server_session_token ?? result.ps_access_token)
                ? {
                    url: result.personal_server_url,
                    session_token:
                      result.personal_server_session_token ??
                      result.ps_access_token ??
                      "",
                    expires_at: expiresAt,
                  }
                : null,
          };

          await callbacks.onAuthorized(creds);
          return creds;
        }

        if (result.status === "expired") {
          callbacks.onExpired();
          return null;
        }

        if (result.status === "slow_down") {
          interval += 5_000;
          continue;
        }

        // status === "pending" — continue polling
      } catch (error) {
        if (flow.kind === "legacy") {
          // Transient legacy poll error — retry on next interval
          continue;
        }
        throw error;
      }
    }

    // Timed out
    callbacks.onExpired();
    return null;
  } catch (error) {
    callbacks.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}

// ── Self-hosted PS auth (Nextcloud Login Flow v2) ─────────────────────

export type AuthTarget = "cloud" | "self-hosted";

export function getAuthTarget(psUrl: string | null): AuthTarget {
  if (!psUrl) return "cloud";
  if (psUrl.includes(".myvana.app")) return "cloud";
  return "self-hosted";
}

export function resolvePersonalServerUrl(): string | undefined {
  return (
    process.env.VANA_PS_URL ||
    process.env.VANA_PERSONAL_SERVER_URL ||
    loadCredentials()?.personal_server?.url
  );
}

interface LoginV2InitResponse {
  login: string;
  poll: { endpoint: string; token: string };
}

interface LoginV2PollSuccess {
  status: "authorized";
  server: string;
  address: string;
  access_token: string;
  expires_at: string;
}

interface LoginV2PollPending {
  status: "pending";
}

interface LoginV2PollExpired {
  status: "expired";
}

type LoginV2PollResponse =
  | LoginV2PollSuccess
  | LoginV2PollPending
  | LoginV2PollExpired;

const SELF_HOSTED_POLL_INTERVAL_MS = 5_000;

function resolveLoginV2Url(serverUrl: string, endpoint: string): string {
  return new URL(endpoint, `${serverUrl.replace(/\/$/, "")}/`).toString();
}

export async function runSelfHostedLoginFlow(
  serverUrl: string,
  onLoginUrl: (url: string) => void,
): Promise<{
  server: string;
  address: string;
  session_token: string;
  expires_at: string;
}> {
  const base = serverUrl.replace(/\/$/, "");

  // 1. Initiate login flow
  const initRes = await fetch(`${base}/auth/device`, { method: "POST" });
  if (!initRes.ok) {
    throw new Error(
      `Server at ${base} does not support CLI login (${initRes.status})`,
    );
  }
  const init = (await initRes.json()) as LoginV2InitResponse;

  // 2. Open browser
  onLoginUrl(resolveLoginV2Url(base, init.login));

  // 3. Poll for completion (5 min timeout)
  const deadline = Date.now() + 5 * 60 * 1000;
  const pollUrl = resolveLoginV2Url(base, init.poll.endpoint);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SELF_HOSTED_POLL_INTERVAL_MS));

    const pollRes = await fetch(
      `${pollUrl}?token=${encodeURIComponent(init.poll.token)}`,
    );

    if (pollRes.status === 200) {
      const result = (await pollRes.json()) as LoginV2PollSuccess;
      if (!isWalletAddress(result.address)) {
        throw new Error(
          "Personal Server did not report a valid owner wallet address. Ensure VANA_MASTER_KEY_SIGNATURE is configured.",
        );
      }
      return {
        server: result.server,
        address: result.address,
        session_token: result.access_token,
        expires_at: result.expires_at,
      };
    }

    if (pollRes.status === 404 || pollRes.status === 202) {
      const result = (await pollRes
        .json()
        .catch(() => null)) as LoginV2PollResponse | null;

      if (result?.status === "expired") {
        throw new Error("Authorization expired. Please try again.");
      }

      continue;
    }

    if (pollRes.status === 429) {
      continue;
    }

    if (!pollRes.ok) {
      throw new Error(`Poll failed: ${pollRes.status}`);
    }
  }

  throw new Error("Authorization timed out. Please try again.");
}
