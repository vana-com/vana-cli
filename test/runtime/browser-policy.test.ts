import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import {
  launchPersistentContext,
  resolveBrowserPath,
} from "../../src/runtime/playwright/browser.js";
import { ManagedPlaywrightRuntime } from "../../src/runtime/managed-playwright.js";
import {
  browserEnvironment,
  ensureConnectorBrowser,
} from "../../src/pdpp/host.js";

const originalPlatform = process.platform;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const temporary: string[] = [];

function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

function availableChrome(available: boolean) {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    String(file) === chrome ? available : exists(file),
  );
}

function cachedBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-browser-policy-"));
  temporary.push(dir);
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", dir);
  const relative =
    process.platform === "darwin"
      ? "chromium-999/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : process.platform === "win32"
        ? "chromium-999/chrome-win64/chrome.exe"
        : "chromium-999/chrome-linux64/chrome";
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "unused browser fixture");
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  platform(originalPlatform);
  for (const dir of temporary.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("macOS automatic local browser policy", () => {
  it("uses system Chrome for managed and PDPP collection", () => {
    platform("darwin");
    availableChrome(true);
    cachedBrowser();
    expect(resolveBrowserPath()).toBe(chrome);
    expect(browserEnvironment()).toEqual({ PDPP_BROWSER_CHANNEL: "chrome" });
  });

  it("rejects a cached browser when Chrome is missing, including managed setup", async () => {
    platform("darwin");
    availableChrome(false);
    cachedBrowser();
    // copy-assertion-ok: missing-Chrome recovery must identify the required system browser and installation location.
    expect(() => resolveBrowserPath()).toThrow(/Google Chrome.*Applications/);
    // copy-assertion-ok: managed setup must give the same actionable missing-Chrome installation requirement.
    await expect(
      new ManagedPlaywrightRuntime().ensureInstalled(true),
    ).rejects.toThrow(/Google Chrome.*Applications/);
    expect(browserEnvironment()).toEqual({ PDPP_BROWSER_CHANNEL: "chrome" });
  });

  it("does not install Chromium for a required PDPP browser when Chrome is missing", async () => {
    platform("darwin");
    availableChrome(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-browser-install-"));
    temporary.push(dir);
    const log = path.join(dir, "setup.log");
    fs.writeFileSync(log, "");
    const invoked = path.join(dir, "installer-invoked");
    const sentinel = Buffer.from(
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(invoked)}, "invoked"); process.exit(0);`,
    ).toString("base64");
    vi.stubEnv(
      "NODE_OPTIONS",
      `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript;base64,${sentinel}`,
    );
    execFileSync(process.execPath, ["--eval", ""]);
    expect(fs.existsSync(invoked)).toBe(true);
    fs.rmSync(invoked);
    // copy-assertion-ok: missing Chrome must reject with its installation remedy before any installer executable runs.
    await expect(
      ensureConnectorBrowser(
        { path: process.execPath, version: "24.22.1" },
        log,
      ),
    ).rejects.toThrow(/Google Chrome.*Applications/);
    expect(fs.existsSync(invoked)).toBe(false);
  });

  it.each(["linux", "win32"] as const)(
    "preserves the %s cached-browser path",
    (target) => {
      platform(target);
      const exists = fs.existsSync;
      vi.spyOn(fs, "existsSync").mockImplementation((file) =>
        String(file) === "/usr/bin/google-chrome" ? false : exists(file),
      );
      const cached = cachedBrowser();
      expect(resolveBrowserPath()).toBe(cached);
      expect(browserEnvironment()).toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    },
  );
});

describe("browser launch diagnostics", () => {
  it("explains an observed macOS sandbox initialization failure without retrying", async () => {
    platform("darwin");
    const failure = new Error(
      "browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=123][err] sandbox initialization failed: Operation not permitted (1)",
    );
    const launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockRejectedValue(failure);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-browser-launch-"));
    temporary.push(dir);
    // copy-assertion-ok: observed macOS sandbox failure must retain the explicit sandbox diagnosis.
    await expect(
      launchPersistentContext(dir, true, "/fixture/chrome"),
    ).rejects.toThrow(/Chrome could not initialize its macOS sandbox/);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "Target page, context or browser has been closed",
    "net::ERR_CONNECTION_CLOSED",
    "profile is in use",
  ])("preserves unrelated launch errors: %s", async (message) => {
    platform("darwin");
    const failure = new Error(message);
    vi.spyOn(chromium, "launchPersistentContext").mockRejectedValue(failure);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vana-browser-launch-"));
    temporary.push(dir);
    await expect(
      launchPersistentContext(dir, true, "/fixture/chrome"),
    ).rejects.toBe(failure);
  });
});
