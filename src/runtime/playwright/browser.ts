import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { chromium, type BrowserContext } from "playwright";

const CHROME_PATHS: Record<NodeJS.Platform, string | undefined> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  linux: "/usr/bin/google-chrome",
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  cygwin: undefined,
  netbsd: undefined,
  sunos: undefined,
};

const CHROME_PROFILE_DIRS: Record<NodeJS.Platform, string | undefined> = {
  darwin: path.join(
    process.env.HOME || "",
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  ),
  win32: path.join(
    process.env.LOCALAPPDATA || "",
    "Google",
    "Chrome",
    "User Data",
  ),
  linux: path.join(process.env.HOME || "", ".config", "google-chrome"),
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  cygwin: undefined,
  netbsd: undefined,
  sunos: undefined,
};

export function getBrowserCacheDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [path.join(home, ".vana", "browsers")];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  return candidates[0];
}

export function getSystemChromePath(): string | null {
  const chromePath = CHROME_PATHS[process.platform];
  if (chromePath && fs.existsSync(chromePath)) {
    return chromePath;
  }

  if (process.platform === "win32") {
    const altPaths = [
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(
        process.env.LOCALAPPDATA || "",
        "Google\\Chrome\\Application\\chrome.exe",
      ),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const candidate of altPaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function getDownloadedChromiumPath(): string | null {
  const cacheDir = getBrowserCacheDir();
  if (!fs.existsSync(cacheDir)) {
    return null;
  }

  const chromiumDir = fs
    .readdirSync(cacheDir)
    .find(
      (entry) => entry.startsWith("chromium-") && !entry.includes("headless"),
    );
  if (!chromiumDir) {
    return null;
  }

  const chromiumPath = path.join(cacheDir, chromiumDir);
  const candidates =
    process.platform === "darwin"
      ? [
          path.join(
            chromiumPath,
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          path.join(
            chromiumPath,
            "chrome-mac",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
          path.join(
            chromiumPath,
            "chrome-mac-arm64",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium",
          ),
          path.join(
            chromiumPath,
            "chrome-mac",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium",
          ),
        ]
      : process.platform === "win32"
        ? [
            path.join(chromiumPath, "chrome-win", "chrome.exe"),
            path.join(chromiumPath, "chrome-win64", "chrome.exe"),
          ]
        : [
            path.join(chromiumPath, "chrome-linux", "chrome"),
            path.join(chromiumPath, "chrome-linux64", "chrome"),
          ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isSystemChrome(browserPath: string | null): boolean {
  if (!browserPath) {
    return false;
  }

  const lower = browserPath.toLowerCase();
  if (
    lower.includes(".databridge") ||
    lower.includes("chromium") ||
    lower.includes("chrome for testing")
  ) {
    return false;
  }

  return true;
}

export function getChromeProfileDir(chromeRoot: string): string | null {
  const localStatePath = path.join(chromeRoot, "Local State");
  if (fs.existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(
        fs.readFileSync(localStatePath, "utf8"),
      ) as {
        profile?: { last_used?: string };
      };
      const lastUsed = localState.profile?.last_used;
      if (lastUsed) {
        const profileDir = path.join(chromeRoot, lastUsed);
        if (fs.existsSync(profileDir)) {
          return profileDir;
        }
      }
    } catch {
      // Ignore malformed local state and fall back to Default.
    }
  }

  const defaultDir = path.join(chromeRoot, "Default");
  return fs.existsSync(defaultDir) ? defaultDir : null;
}

export function supportsSystemChromeCookieImport(): boolean {
  if (process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT === "1") {
    return true;
  }

  // Treat this as a macOS-only enhancement until we have explicit
  // validation for other platforms. The core CLI path should not depend on it.
  return process.platform === "darwin";
}

export function importChromeCookies(
  userDataDir: string,
  browserPath: string | null,
): void {
  if (!supportsSystemChromeCookieImport()) {
    return;
  }

  if (!isSystemChrome(browserPath)) {
    return;
  }

  const markerFile = path.join(userDataDir, ".cookies-imported");
  if (fs.existsSync(markerFile)) {
    return;
  }

  const chromeRoot = CHROME_PROFILE_DIRS[process.platform];
  if (!chromeRoot || !fs.existsSync(chromeRoot)) {
    return;
  }

  const sourceProfileDir = getChromeProfileDir(chromeRoot);
  if (!sourceProfileDir) {
    return;
  }

  const sourceCookies = path.join(sourceProfileDir, "Cookies");
  if (!fs.existsSync(sourceCookies)) {
    return;
  }

  const targetCookies = path.join(userDataDir, "Default", "Cookies");
  if (!fs.existsSync(targetCookies)) {
    return;
  }

  const sourceDb = sourceCookies.replace(/'/g, "''");
  const sql = `
ATTACH DATABASE '${sourceDb}' AS src;
INSERT OR REPLACE INTO main.cookies
SELECT * FROM src.cookies;
DETACH DATABASE src;
`;

  try {
    execFileSync("sqlite3", [targetCookies, sql.replace(/\n/g, " ")], {
      stdio: "ignore",
    });
    fs.writeFileSync(markerFile, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // Cookie import is opportunistic; continue if sqlite3 is unavailable.
  }
}

export function resolveBrowserPath(): string {
  let browserPath: string | null = null;

  if (!process.env.DATACONNECT_SIMULATE_NO_CHROME) {
    browserPath = getSystemChromePath();
  }

  if (!browserPath) {
    browserPath = getDownloadedChromiumPath();
  }

  if (!browserPath) {
    throw new Error(
      "No browser available. Run `vana setup` to install Chromium before connecting a source.",
    );
  }

  return browserPath;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The pid still holding a Chromium profile, or null when nothing holds it.
 *
 * Chromium writes `SingletonLock` as a symlink whose target is
 * `<hostname>-<pid>`, and the hostname itself may contain dashes, so only the
 * final segment is the pid. A lock pointing at a dead process is stale.
 */
export function readProfileLockOwner(
  lockPath: string,
  isRunning: (pid: number) => boolean = processIsRunning,
): number | null {
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    // Absent, or not a symlink: nothing live is claiming the profile.
    return null;
  }

  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return isRunning(pid) ? pid : null;
}

/**
 * The major version of the browser at `browserPath`, or null when it cannot
 * be read. `--version` prints e.g. `Google Chrome 153.0.8010.48`; on Windows
 * it prints nothing, so an undetectable version is an expected outcome.
 */
export function readBrowserMajorVersion(
  browserPath: string | null,
  readVersion: (executable: string) => string = (executable) =>
    execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
): number | null {
  if (!browserPath) {
    return null;
  }

  try {
    const match = /(\d+)\.\d+\.\d+\.\d+/.exec(readVersion(browserPath));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Playwright's bundled Chromium, used when no browser path was resolved. */
function safeChromiumExecutablePath(): string | null {
  try {
    return chromium.executablePath() || null;
  } catch {
    return null;
  }
}

/**
 * The user agent to present, or undefined to leave the browser's own.
 *
 * Headless Chromium announces itself as `HeadlessChrome`, which sites block,
 * so the user agent is overridden. The override must carry the version of the
 * browser actually running: sites that enforce a supported-browser floor
 * (Slack answers 403 "your browser is not supported") reject a stale one, and
 * a version that disagrees with the client hints is itself a bot signal. The
 * string follows Chrome's reduced format, where only the major version varies.
 */
export function buildUserAgent(
  majorVersion: number | null,
  headless: boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (majorVersion === null) {
    // A headed browser's own user agent is already truthful. Headless has no
    // good answer without a version, so keep the historical floor.
    if (!headless) {
      return undefined;
    }
    majorVersion = 120;
  }

  const platformToken =
    platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";

  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
}

export async function launchPersistentContext(
  userDataDir: string,
  headless: boolean,
  browserPath: string | null,
): Promise<BrowserContext> {
  fs.mkdirSync(userDataDir, { recursive: true });

  // Chromium refuses to share a profile between instances. A lock left by a
  // crashed browser is safe to clear, but one held by a live process is not:
  // removing it lets a second Chromium onto the same profile, which is the
  // corruption the lock exists to prevent.
  const lockPath = path.join(userDataDir, "SingletonLock");
  const holder = readProfileLockOwner(lockPath);
  if (holder !== null) {
    throw new Error(
      `Another Vana browser session (pid ${holder}) is already using the profile at ${userDataDir}. ` +
        `That is usually an earlier \`vana connect\` still waiting for you to finish signing in. ` +
        `Finish that sign-in, or stop it with \`kill ${holder}\`, then try again.`,
    );
  }
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore — file might not exist or be unremovable.
  }

  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] =
    {
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=MediaRouter,DialMediaRouteProvider",
      ],
      viewport: { width: 1280, height: 800 },
    };

  const userAgent = buildUserAgent(
    readBrowserMajorVersion(browserPath ?? safeChromiumExecutablePath()),
    headless,
  );
  if (userAgent) {
    launchOptions.userAgent = userAgent;
  }

  if (browserPath) {
    launchOptions.executablePath = browserPath;
  }

  if (isSystemChrome(browserPath)) {
    launchOptions.ignoreDefaultArgs = ["--use-mock-keychain"];
  }

  return chromium.launchPersistentContext(userDataDir, launchOptions);
}

export function getDefaultUserDataDir(slug: string): string {
  return path.join(os.homedir(), ".vana", "browser-profiles", slug);
}
