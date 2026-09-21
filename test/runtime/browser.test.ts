import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockReadlinkSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    readdirSync: mockReaddirSync,
    readlinkSync: mockReadlinkSync,
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

describe("importChromeCookies", () => {
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalOverride = process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    mockExecFileSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    process.env.HOME = originalHome;
    process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalOverride === undefined) {
      delete process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT;
    } else {
      process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT = originalOverride;
    }
  });

  it("skips system cookie import on Windows by default", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    process.env.LOCALAPPDATA = "C:\\Users\\Tim\\AppData\\Local";
    delete process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT;

    mockExistsSync.mockReturnValue(true);

    const { importChromeCookies } =
      await import("../../src/runtime/playwright/browser.js");

    importChromeCookies("C:\\profile", "C:\\browser\\chrome.exe");

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("can invoke sqlite3 on Windows when the explicit override is enabled", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    process.env.LOCALAPPDATA = "C:\\Users\\Tim\\AppData\\Local";
    process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT = "1";

    mockExistsSync.mockImplementation((target: string) => {
      const normalized = target.replace(/\//g, "\\");
      return (
        normalized === "C:\\browser\\chrome.exe" ||
        normalized ===
          "C:\\Users\\Tim\\AppData\\Local\\Google\\Chrome\\User Data" ||
        normalized ===
          "C:\\Users\\Tim\\AppData\\Local\\Google\\Chrome\\User Data\\Local State" ||
        normalized ===
          "C:\\Users\\Tim\\AppData\\Local\\Google\\Chrome\\User Data\\Default" ||
        normalized ===
          "C:\\Users\\Tim\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies" ||
        normalized === "C:\\profile\\Default\\Cookies"
      );
    });

    const { importChromeCookies } =
      await import("../../src/runtime/playwright/browser.js");

    importChromeCookies("C:\\profile", "C:\\browser\\chrome.exe");

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "sqlite3",
      [
        expect.stringContaining("C:\\profile"),
        expect.stringContaining("ATTACH DATABASE"),
      ],
      { stdio: "ignore" },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("C:\\profile"),
      expect.stringContaining("T"),
      "utf8",
    );
  });

  it("skips system cookie import on Linux by default", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    process.env.HOME = "/home/tim";

    mockExistsSync.mockReturnValue(true);

    const { importChromeCookies } =
      await import("../../src/runtime/playwright/browser.js");

    importChromeCookies("/profile", "/browser/chrome");

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("swallows sqlite3 failures under the explicit Linux override", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    process.env.HOME = "/home/tim";
    process.env.VANA_ENABLE_SYSTEM_COOKIE_IMPORT = "1";

    mockExistsSync.mockImplementation((target: string) =>
      [
        "/browser/chrome",
        "/home/tim/.config/google-chrome",
        "/home/tim/.config/google-chrome/Local State",
        "/home/tim/.config/google-chrome/Default",
        "/home/tim/.config/google-chrome/Default/Cookies",
        "/profile/Default/Cookies",
      ].includes(target),
    );
    mockExecFileSync.mockImplementation(() => {
      throw new Error("sqlite3 not found");
    });

    const { importChromeCookies } =
      await import("../../src/runtime/playwright/browser.js");

    expect(() =>
      importChromeCookies("/profile", "/browser/chrome"),
    ).not.toThrow();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("readProfileLockOwner", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    return (await import("../../src/runtime/playwright/browser.js"))
      .readProfileLockOwner;
  }

  it("reports the pid when the holding browser is still alive", async () => {
    // A hostname may itself contain dashes; only the last segment is the pid.
    mockReadlinkSync.mockReturnValue("Vana-Volodymyr-Isai-s-Mac.local-80496");
    const readProfileLockOwner = await load();

    expect(readProfileLockOwner("/profile/SingletonLock", () => true)).toBe(
      80496,
    );
  });

  it("treats a lock left by a dead process as stale", async () => {
    mockReadlinkSync.mockReturnValue("some-host-4242");
    const readProfileLockOwner = await load();

    expect(readProfileLockOwner("/profile/SingletonLock", () => false)).toBe(
      null,
    );
  });

  it("treats a missing lock as unheld", async () => {
    mockReadlinkSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const readProfileLockOwner = await load();

    expect(readProfileLockOwner("/profile/SingletonLock", () => true)).toBe(
      null,
    );
  });

  it("ignores a lock target that carries no pid", async () => {
    mockReadlinkSync.mockReturnValue("hostname-only");
    const readProfileLockOwner = await load();

    expect(readProfileLockOwner("/profile/SingletonLock", () => true)).toBe(
      null,
    );
  });
});

describe("readBrowserMajorVersion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    return (await import("../../src/runtime/playwright/browser.js"))
      .readBrowserMajorVersion;
  }

  it("reads the major version from Chrome's --version output", async () => {
    const readBrowserMajorVersion = await load();

    expect(
      readBrowserMajorVersion(
        "/chrome",
        () => "Google Chrome 153.0.8010.48 \n",
      ),
    ).toBe(153);
  });

  it("reads the major version from a Playwright Chromium build", async () => {
    const readBrowserMajorVersion = await load();

    expect(
      readBrowserMajorVersion(
        "/chromium",
        () => "Google Chrome for Testing 140.0.7339.16",
      ),
    ).toBe(140);
  });

  it("reports an unknown version when the browser prints nothing", async () => {
    const readBrowserMajorVersion = await load();

    expect(readBrowserMajorVersion("/chrome.exe", () => "")).toBe(null);
  });

  it("reports an unknown version when the browser cannot be run", async () => {
    const readBrowserMajorVersion = await load();

    expect(
      readBrowserMajorVersion("/missing", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(null);
  });

  it("reports an unknown version when no browser path is known", async () => {
    const readBrowserMajorVersion = await load();

    expect(readBrowserMajorVersion(null, () => "Google Chrome 1.2.3.4")).toBe(
      null,
    );
  });
});

describe("buildUserAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    return (await import("../../src/runtime/playwright/browser.js"))
      .buildUserAgent;
  }

  it("carries the running browser's version, not a fixed one", async () => {
    const buildUserAgent = await load();

    expect(buildUserAgent(153, true, "darwin")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
  });

  it("never announces a headless browser", async () => {
    const buildUserAgent = await load();

    expect(buildUserAgent(153, true, "linux")).not.toContain("Headless");
    expect(buildUserAgent(null, true, "linux")).not.toContain("Headless");
  });

  it("matches the platform the browser really runs on", async () => {
    const buildUserAgent = await load();

    expect(buildUserAgent(153, false, "win32")).toContain(
      "Windows NT 10.0; Win64; x64",
    );
    expect(buildUserAgent(153, false, "linux")).toContain("X11; Linux x86_64");
  });

  it("leaves a headed browser's own user agent alone when the version is unknown", async () => {
    const buildUserAgent = await load();

    expect(buildUserAgent(null, false, "darwin")).toBeUndefined();
  });
});
