import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launchPersistentContext = vi.fn();
const resolveBrowserPath = vi.fn(() => "/tmp/chrome");
const importChromeCookies = vi.fn();
const isSystemChrome = vi.fn(() => false);
const getDefaultUserDataDir = vi.fn((slug: string) =>
  path.join(os.tmpdir(), ".vana-browser-profiles", slug),
);

vi.mock("../../src/runtime/playwright/browser.js", () => ({
  launchPersistentContext,
  resolveBrowserPath,
  importChromeCookies,
  isSystemChrome,
  getDefaultUserDataDir,
}));

type FakePage = {
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
};

type FakeContext = {
  pages: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  cookies: ReturnType<typeof vi.fn>;
  browser: ReturnType<typeof vi.fn>;
};

function createFakeRuntime() {
  const disconnectedHandlers: Array<() => void> = [];
  const page: FakePage = {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from("test")),
    on: vi.fn(),
    url: vi.fn(() => "https://example.com/login"),
  };

  const context: FakeContext = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
    cookies: vi.fn(async () => []),
    browser: vi.fn(() => ({
      on: (_event: string, handler: () => void) => {
        disconnectedHandlers.push(handler);
      },
    })),
  };

  launchPersistentContext.mockResolvedValue(context);
  return { page, context, disconnectedHandlers };
}

async function writeConnector(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vana-connect-test-"));
  const connectorPath = path.join(dir, "test-playwright.js");
  await fs.writeFile(connectorPath, contents, "utf8");
  return connectorPath;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setTty(stdin: boolean | undefined, stdout: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: stdin,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: stdout,
    configurable: true,
  });
}

describe("startInProcessConnectorRun", () => {
  beforeEach(() => {
    launchPersistentContext.mockReset();
    resolveBrowserPath.mockClear();
    importChromeCookies.mockClear();
    isSystemChrome.mockClear();
    getDefaultUserDataDir.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("emits needs-input for requestInput in no-input mode", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  await page.requestInput({
    message: "Log in",
    schema: {
      type: "object",
      properties: {
        username: { type: "string" },
        password: { type: "string", format: "password" }
      }
    }
  });
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");

    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "github",
        noInput: true,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-needs-input.log"),
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-started", source: "github" }),
        expect.objectContaining({
          type: "needs-input",
          source: "github",
          fields: ["username", "password"],
        }),
      ]),
    );
  });

  it("emits legacy-auth for promptUser connectors", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  await page.promptUser("Please log in", async () => false);
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");

    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "spotify",
        noInput: true,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-legacy-auth.log"),
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-started", source: "spotify" }),
        expect.objectContaining({ type: "legacy-auth", source: "spotify" }),
      ]),
    );
  });

  it("emits legacy-auth for showBrowser connectors in no-input mode", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  await page.showBrowser("https://shop.app/account/order-history");
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");

    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "shop",
        noInput: true,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-showbrowser-legacy.log"),
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run-started", source: "shop" }),
        expect.objectContaining({ type: "legacy-auth", source: "shop" }),
      ]),
    );
  });

  it("supports headed manual flows for legacy connectors in human mode", async () => {
    createFakeRuntime();
    const previousDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":99";
    try {
      const connectorPath = await writeConnector(`
(async () => {
  let complete = false;
  setTimeout(() => {
    complete = true;
  }, 5);
  const browser = await page.showBrowser("https://shop.app/account/order-history");
  if (!browser.headed) {
    throw new Error("Expected headed browser");
  }
  await page.promptUser("Finish signing in to Shop in the browser window.", async () => complete, 1);
  return { orders: [] };
})();
`);

      const { startInProcessConnectorRun } =
        await import("../../src/runtime/playwright/in-process-run.js");

      const handle = startInProcessConnectorRun({
        request: {
          connectorPath,
          source: "shop",
          noInput: false,
        },
        logPath: path.join(os.tmpdir(), "vana-connect-headed-manual.log"),
      });

      const events = [];
      for await (const event of handle.events()) {
        events.push(event);
      }

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "run-started", source: "shop" }),
          expect.objectContaining({ type: "headed-required", source: "shop" }),
          expect.objectContaining({
            type: "collection-complete",
            source: "shop",
          }),
        ]),
      );
      expect(launchPersistentContext).toHaveBeenCalledWith(
        expect.any(String),
        false,
        "/tmp/chrome",
      );
    } finally {
      process.env.DISPLAY = previousDisplay;
    }
  });

  it("signs a password connector in through the browser at a terminal, never asking for the password", async () => {
    createFakeRuntime();
    const previousDisplay = process.env.DISPLAY;
    const previousTty = [process.stdin.isTTY, process.stdout.isTTY] as const;
    process.env.DISPLAY = ":99";
    setTty(true, true);
    try {
      const connectorPath = await writeConnector(`
(async () => {
  if (typeof page.requestInput === "function") {
    await page.requestInput({
      message: "Log in",
      schema: { type: "object", properties: {
        username: { type: "string" },
        password: { type: "string", format: "password" }
      } }
    });
    return { signedInWith: "password" };
  }
  await page.showBrowser("https://example.com/login");
  await page.promptUser("Sign in to Example in the browser window.", async () => true, 1);
  return { signedInWith: "browser" };
})();
`);

      const { startInProcessConnectorRun } =
        await import("../../src/runtime/playwright/in-process-run.js");
      const onNeedInput = vi.fn(async () => ({ username: "u", password: "p" }));

      const handle = startInProcessConnectorRun({
        request: {
          connectorPath,
          source: "example",
          noInput: false,
          onNeedInput,
        },
        logPath: path.join(os.tmpdir(), "vana-connect-browser-sign-in.log"),
      });
      const events = [];
      for await (const event of handle.events()) {
        events.push(event);
      }

      expect(onNeedInput).not.toHaveBeenCalled();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "headed-required",
            message: "Sign in to Example in the browser window.",
          }),
          expect.objectContaining({ type: "collection-complete" }),
        ]),
      );
    } finally {
      restoreEnv("DISPLAY", previousDisplay);
      setTty(...previousTty);
    }
  });

  it("keeps the password prompt on a Linux host where no browser window can open", async () => {
    createFakeRuntime();
    const originalPlatform = process.platform;
    const previousDisplay = process.env.DISPLAY;
    const previousWayland = process.env.WAYLAND_DISPLAY;
    const previousTty = [process.stdin.isTTY, process.stdout.isTTY] as const;
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    setTty(true, true);
    try {
      const connectorPath = await writeConnector(`
(async () => {
  if (typeof page.requestInput === "function") {
    await page.requestInput({
      message: "Log in",
      schema: { type: "object", properties: {
        password: { type: "string", format: "password" }
      } }
    });
    return { signedInWith: "password" };
  }
  await page.showBrowser("https://example.com/login");
  return { signedInWith: "browser" };
})();
`);

      const { startInProcessConnectorRun } =
        await import("../../src/runtime/playwright/in-process-run.js");
      const onNeedInput = vi.fn(async () => ({ password: "p" }));
      const handle = startInProcessConnectorRun({
        request: {
          connectorPath,
          source: "example",
          noInput: false,
          onNeedInput,
        },
        logPath: path.join(os.tmpdir(), "vana-connect-no-display.log"),
      });
      const events = [];
      for await (const event of handle.events()) {
        events.push(event);
      }
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "headed-required" }),
      );
      expect(onNeedInput).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      restoreEnv("DISPLAY", previousDisplay);
      restoreEnv("WAYLAND_DISPLAY", previousWayland);
      setTty(...previousTty);
    }
  });

  it("keeps the password prompt when the terminal is not a TTY", async () => {
    createFakeRuntime();
    const previousDisplay = process.env.DISPLAY;
    const previousTty = [process.stdin.isTTY, process.stdout.isTTY] as const;
    process.env.DISPLAY = ":99";
    setTty(undefined, undefined);
    try {
      const connectorPath = await writeConnector(`
(async () => {
  if (typeof page.requestInput === "function") {
    await page.requestInput({
      message: "Log in",
      schema: { type: "object", properties: {
        password: { type: "string", format: "password" }
      } }
    });
    return { signedInWith: "password" };
  }
  await page.showBrowser("https://example.com/login");
  return { signedInWith: "browser" };
})();
`);
      const { startInProcessConnectorRun } =
        await import("../../src/runtime/playwright/in-process-run.js");
      const onNeedInput = vi.fn(async () => ({ password: "p" }));
      const handle = startInProcessConnectorRun({
        request: {
          connectorPath,
          source: "example",
          noInput: false,
          onNeedInput,
        },
        logPath: path.join(os.tmpdir(), "vana-connect-no-tty.log"),
      });
      for await (const event of handle.events()) {
        expect(event.type).not.toBe("headed-required");
      }
      expect(onNeedInput).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv("DISPLAY", previousDisplay);
      setTty(...previousTty);
    }
  });

  it("keeps offering requestInput to agents that answer through files", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  if (false) {
    await page.requestInput({ schema: { properties: { password: { type: "string", format: "password" } } } });
    await page.showBrowser("https://example.com/login");
  }
  await page.setData("result", { offered: typeof page.requestInput === "function" });
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");
    const logPath = path.join(os.tmpdir(), "vana-connect-agent-input.log");
    const handle = startInProcessConnectorRun({
      request: { connectorPath, source: "example", noInput: false },
      logPath,
    });
    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }
    const complete = events.find(
      (event) => event.type === "collection-complete",
    );
    expect(complete).toBeDefined();
    const result = JSON.parse(
      await fs.readFile(
        String((complete as { resultPath: string }).resultPath),
        "utf8",
      ),
    );
    expect(JSON.stringify(result)).toContain('"offered":true');
  });

  it("refuses a second password request in one run instead of asking again", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  const schema = { type: "object", properties: {
    username: { type: "string" },
    password: { type: "string", format: "password" }
  } };
  await page.requestInput({ message: "Log in", schema });
  try {
    await page.requestInput({ message: "Log in - Login form error. Retrying...", schema });
    return { secondAttempt: "asked" };
  } catch (error) {
    return { secondAttempt: "refused", message: error.message };
  }
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");
    const onNeedInput = vi.fn(async () => ({ username: "u", password: "p" }));
    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "example",
        noInput: false,
        onNeedInput,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-password-retry.log"),
    });
    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    expect(onNeedInput).toHaveBeenCalledTimes(1);
    const complete = events.find(
      (event) => event.type === "collection-complete",
    );
    const result = JSON.parse(
      await fs.readFile(
        String((complete as { resultPath: string }).resultPath),
        "utf8",
      ),
    );
    expect(JSON.stringify(result)).toContain('"secondAttempt":"refused"');
    expect(JSON.stringify(result)).toContain("was not tried again");
  });

  it("writes a result and emits collection-complete", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  await page.setData("status", "Collecting");
  return {
    profile: { username: "tester" },
    repositories: []
  };
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");

    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "github",
        noInput: true,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-collection.log"),
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    const completion = events.find(
      (event) => event.type === "collection-complete",
    );
    expect(completion).toEqual(
      expect.objectContaining({
        type: "collection-complete",
        source: "github",
      }),
    );

    const resultPath = (completion as { resultPath: string }).resultPath;
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    expect(result).toEqual({
      profile: { username: "tester" },
      repositories: [],
    });
  });

  it("treats setData('result', ...) as collection completion", async () => {
    createFakeRuntime();
    const connectorPath = await writeConnector(`
(async () => {
  await page.setData("status", "Collecting");
  await page.setData("result", {
    profile: { username: "tester" },
    repositories: []
  });
  await page.setData("status", "Complete!");
})();
`);

    const { startInProcessConnectorRun } =
      await import("../../src/runtime/playwright/in-process-run.js");

    const handle = startInProcessConnectorRun({
      request: {
        connectorPath,
        source: "github",
        noInput: false,
      },
      logPath: path.join(os.tmpdir(), "vana-connect-setdata-result.log"),
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    const completion = events.find(
      (event) => event.type === "collection-complete",
    );
    expect(completion).toEqual(
      expect.objectContaining({
        type: "collection-complete",
        source: "github",
      }),
    );

    const resultPath = (completion as { resultPath: string }).resultPath;
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    expect(result).toEqual({
      profile: { username: "tester" },
      repositories: [],
    });
  });
});
