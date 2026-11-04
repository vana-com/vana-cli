import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  launchPersistentContext,
  resolveBrowserPath,
} from "../dist/runtime/playwright/browser.js";

assert.equal(process.platform, "darwin", "This smoke check requires macOS");
assert.equal(
  process.env.HOME,
  os.userInfo().homedir,
  "Keep the real HOME when launching system Chrome",
);
const root = await mkdtemp(path.join(os.tmpdir(), "vana-browser-smoke-"));
let context;
try {
  const browserPath = resolveBrowserPath();
  console.log(`Using ${browserPath}`);
  context = await launchPersistentContext(
    path.join(root, "profile"),
    true,
    browserPath,
  );
  await context.route("http://127.0.0.1/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<title>Vana local browser fixture</title><input type="file"><a download="fixture.txt" href="data:text/plain,synthetic-download">Download</a>',
    }),
  );
  const page = await context.newPage();
  await page.goto("http://127.0.0.1/vana-browser-fixture");
  assert.equal(await page.title(), "Vana local browser fixture");
  await page.locator("input").setInputFiles({
    name: "fixture.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic-upload"),
  });
  assert.equal(
    await page
      .locator("input")
      .evaluate(async (input) => input.files[0].text()),
    "synthetic-upload",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.locator("a").click();
  const download = await downloadEvent;
  assert.equal(await download.failure(), null);
  const cdp = await context.browser().newBrowserCDPSession();
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const browser = processInfo.find((entry) => entry.type === "browser");
  assert.ok(browser, "Browser PID is available");
  const command = execFileSync(
    "/bin/ps",
    ["-p", String(browser.id), "-o", "command="],
    { encoding: "utf8" },
  );
  assert.ok(
    command.includes(browserPath),
    "Production helper launches system Chrome",
  );
  assert.ok(
    !command.includes("--no-sandbox"),
    "Chrome sandbox is not disabled",
  );
  const renderers = processInfo.filter((entry) => entry.type === "renderer");
  assert.ok(renderers.length > 0, "Fixture has a renderer");
  for (const renderer of renderers) {
    const result = execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        "import ctypes,sys; f=ctypes.CDLL('/usr/lib/libsandbox.1.dylib',use_errno=True).sandbox_check; print(f(int(sys.argv[1]),None,0))",
        String(renderer.id),
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(result, "1", `Renderer ${renderer.id} has a macOS sandbox`);
  }
  console.log(
    `PASS system Chrome ${context.browser().version()}; ${renderers.length} sandboxed renderers; local navigation, upload and download`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
