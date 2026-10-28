#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import ts from "typescript";
import { startMotel, exportAndQuery } from "./motel.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  mkdtemp,
  access,
  rename,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, "../../../..");
const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
if (args.includes("--help")) {
  console.log(
    "Usage: node verify.mjs --doctor | --evidence <new-absolute-directory> [--negative-control missing-save|save-failure|ack-failure|read-interrupted|missing-observations] [--motel-endpoint http://127.0.0.1:27686]\nExit 0: controlled clauses passed. Exit 1: assertion failed. Exit 2: setup blocked.\nNo live provider, Account/Web approval or payment is verified by this lane.",
  );
  process.exit(0);
}
async function dependencies() {
  await access(path.join(root, "dist/index.js"));
  const packages = await readdir(path.join(root, "node_modules/.pnpm"));
  const playwright = packages.find((name) => /^playwright@/.test(name));
  assert(
    playwright,
    "An installed Playwright package is required. Do not install automatically.",
  );
  const next = path.join(
    root,
    "examples/perplexity-demo/node_modules/next/dist/bin/next",
  );
  await access(next);
  let executable = process.env.SHELF_VERIFY_CHROMIUM;
  if (!executable) {
    const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
    const browsers = (await readdir(cache))
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse();
    for (const candidate of browsers) {
      const file = path.join(
        cache,
        candidate,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      try {
        await stat(file);
        executable = file;
        break;
      } catch {}
    }
  }
  assert(
    executable,
    "Set SHELF_VERIFY_CHROMIUM to an already installed Chromium executable.",
  );
  await access(executable);
  const motelBinary =
    process.env.MOTEL_BINARY ?? path.join(os.homedir(), ".local/bin/motel");
  await access(motelBinary);
  return { next, playwright, executable, motelBinary };
}
if (args.includes("--doctor")) {
  try {
    console.log(
      JSON.stringify({
        ready: true,
        root,
        node: process.version,
        ...(await dependencies()),
        lane: "controlled-real-app",
        network: "none",
        launches: "none",
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ ready: false, error: error.message }));
    process.exitCode = 2;
  }
} else await verify();

async function verify() {
  const evidence = option("--evidence");
  const negative = option("--negative-control");
  if (
    !evidence ||
    !path.isAbsolute(evidence) ||
    (negative &&
      ![
        "missing-save",
        "save-failure",
        "ack-failure",
        "read-interrupted",
        "missing-observations",
      ].includes(negative))
  )
    throw new Error("Use --help for arguments.");
  await mkdir(evidence, { recursive: false, mode: 0o700 });
  const runtime = await mkdtemp(
    path.join(os.tmpdir(), "shelf-verify-runtime-"),
  );
  const appDir = path.join(runtime, "app");
  const storage = path.join(runtime, "private-store");
  const stateFile = path.join(runtime, "fixture.json");
  const eventsFile = path.join(evidence, "events.jsonl");
  const observationFile = path.join(evidence, "observations.jsonl");
  const observationRun = randomUUID();
  const observationSalt = randomBytes(32).toString("hex");
  let observer, motel;
  const result = {
    lane: "controlled-real-app",
    negativeControl: negative ?? null,
    startedAt: new Date().toISOString(),
    passed: false,
    clauses: {},
    blocked: [
      "Real provider collection and genuine connector-source edit",
      "Real Account/Web consent and deployed service behavior",
      "Charged app read and payment settlement",
      "Full PRD step 4/5 acceptance outside the controlled fixture transport",
    ],
    cleanup: {},
  };
  let appProcess,
    browser,
    activePage,
    phase = "setup",
    appLog = "",
    origin;
  const events = [];
  let interruptedSignal;
  const interrupt = (signal) => {
    interruptedSignal = signal;
    result.passed = false;
    result.interrupted = signal;
    observerFailure ??= new Error(`Verifier interrupted by ${signal}`);
    if (browser) void browser.close().catch(() => {});
    if (appProcess?.pid && !stopped()) {
      try {
        process.kill(-appProcess.pid, "SIGTERM");
      } catch {}
    }
  };
  const onTerm = () => interrupt("SIGTERM");
  const onInt = () => interrupt("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  let observerFailure;
  async function guardedRoute(route, run) {
    try {
      await run();
    } catch (error) {
      observerFailure ??= error;
      await event("observer-failed", { error: error.message });
      await route.abort("failed").catch(() => {});
    }
  }
  let state = {
    title: "Verifier baseline conversation",
    version: 1,
    approval: "pending",
    ackFailure: negative === "ack-failure",
    readFailure: false,
    saveFailure: negative === "save-failure",
    readInterrupted: negative === "read-interrupted",
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  async function fixture(patch) {
    state = { ...state, ...patch };
    const temporary = `${stateFile}.next`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, stateFile);
  }
  async function event(stage, details = {}) {
    events.push({ time: Date.now(), stage, ...details });
  }
  async function serviceEvents() {
    try {
      return (await readFile(eventsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async function servedCount() {
    return (await serviceEvents()).filter(
      (entry) => entry.stage === "data-served",
    ).length;
  }
  async function connection() {
    const names = (await readdir(storage)).filter((name) =>
      name.endsWith(".json"),
    );
    assert.equal(names.length, 1, "exactly one private connection must exist");
    const file = path.join(storage, names[0]);
    return { file, state: JSON.parse(await readFile(file, "utf8")) };
  }
  async function until(run, description, timeout = 45000) {
    const start = Date.now();
    let error;
    while (Date.now() - start < timeout) {
      if (observerFailure) throw observerFailure;
      try {
        return await run();
      } catch (caught) {
        error = caught;
        await pause(200);
      }
    }
    throw new Error(`${description}: ${error?.message ?? "timed out"}`);
  }
  async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }
  function stopped() {
    return (
      !appProcess ||
      appProcess.exitCode !== null ||
      appProcess.signalCode !== null
    );
  }
  async function waitExit(milliseconds) {
    if (stopped()) return;
    await new Promise((resolve) => {
      const ended = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        appProcess.removeListener("exit", ended);
        resolve();
      }, milliseconds);
      appProcess.once("exit", ended);
    });
  }
  async function stopApp() {
    if (stopped()) return;
    try {
      process.kill(-appProcess.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await waitExit(8000);
    if (!stopped()) {
      try {
        process.kill(-appProcess.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await waitExit(3000);
    }
  }
  async function portClosed() {
    if (!origin) return true;
    return new Promise((resolve) => {
      const socket = createConnection({
        port: Number(new URL(origin).port),
        host: "127.0.0.1",
      });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }
  async function launch(next) {
    const port = Number(new URL(origin).port);
    const env = {
      ...process.env,
      NODE_OPTIONS: `--import=${path.join(scripts, "fixture-preload.mjs")}`,
      NEXT_TELEMETRY_DISABLED: "1",
      VANA_PRIVATE_KEY:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      VANA_APP_ADDRESS: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      VANA_ENV: "dev",
      APP_URL: origin,
      VANA_SHELF_DIRECTORY: storage,
      VANA_ALLOW_MOKSHA_PAYMENT: "false",
      VANA_SHELF_OBSERVABILITY_FILE: observationFile,
      VANA_SHELF_OBSERVABILITY_RUN: observationRun,
      VANA_SHELF_OBSERVABILITY_MODE: "controlled",
      VANA_SHELF_OBSERVABILITY_SALT: observationSalt,
      SHELF_VERIFY_STORAGE: storage,
      SHELF_VERIFY_STATE: stateFile,
      SHELF_VERIFY_ORIGIN: origin,
      SHELF_VERIFY_EVENTS: eventsFile,
    };
    for (const key of [
      "VANA_MAX_FEE",
      "VANA_MAX_TOTAL",
      "VANA_RESUME_REQUEST_ID",
      "VANA_APPROVAL_URL",
      "VANA_APP_PRIVATE_KEY",
    ])
      delete env[key];
    appProcess = spawn(
      process.execPath,
      [next, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: appDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    appProcess.stdout.on("data", (data) => {
      appLog += data.toString();
    });
    appProcess.stderr.on("data", (data) => {
      appLog += data.toString();
    });
    await until(
      async () => {
        assert.equal(
          appProcess.exitCode,
          null,
          `owned Next process exited ${appProcess.exitCode}`,
        );
        const response = await fetch(origin);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Research Shelf/);
      },
      "Research Shelf doctor",
      90000,
    );
    await event("doctor-passed", { pid: appProcess.pid, origin });
  }
  try {
    const dep = await dependencies();
    const observerSource = await readFile(
      path.join(root, "examples/perplexity-demo/src/server/observability.ts"),
      "utf8",
    );
    const observerModule = path.join(runtime, "observer.mjs");
    await writeFile(
      observerModule,
      ts.transpileModule(observerSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    );
    const { createShelfObserver } = await import(
      pathToFileURL(observerModule).href
    );
    await writeFile(
      path.join(evidence, "correlation-context.json"),
      JSON.stringify({
        run: observationRun,
        mode: "controlled",
        salt: observationSalt,
        file: observationFile,
      }),
      { mode: 0o600 },
    );
    observer = createShelfObserver({
      file: observationFile,
      run: observationRun,
      mode: "controlled",
      salt: observationSalt,
    });
    motel = await startMotel({
      evidenceDir: path.join(evidence, "motel"),
      endpoint: option("--motel-endpoint"),
    });
    if (interruptedSignal)
      throw new Error(`Verifier interrupted by ${interruptedSignal}`);
    result.motel = {
      run: observationRun,
      endpoint: motel.endpoint,
      identity: motel.identity,
    };
    await cp(path.join(root, "examples/perplexity-demo"), appDir, {
      recursive: true,
      filter: (source) =>
        !["node_modules", ".next"].includes(path.basename(source)) &&
        !path.basename(source).startsWith(".research-shelf") &&
        !path.basename(source).startsWith(".env"),
    });
    await symlink(
      path.join(root, "examples/perplexity-demo/node_modules"),
      path.join(appDir, "node_modules"),
      "dir",
    );
    await fixture({});
    origin = `http://127.0.0.1:${await freePort()}`;
    const { chromium } = await import(
      pathToFileURL(
        path.join(
          root,
          "node_modules/.pnpm",
          dep.playwright,
          "node_modules/playwright/index.mjs",
        ),
      ).href
    );
    const hashes = {};
    async function fingerprint(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await fingerprint(full);
        else hashes[path.relative(root, full)] = hash(await readFile(full));
      }
    }
    await fingerprint(path.join(root, "examples/perplexity-demo/src"));
    for (const file of [
      "pnpm-lock.yaml",
      "dist/index.js",
      "examples/perplexity-demo/package.json",
      "examples/perplexity-demo/next.config.js",
      "examples/perplexity-demo/tsconfig.json",
      ".agents/skills/verify-research-shelf/scripts/verify.mjs",
      ".agents/skills/verify-research-shelf/scripts/fixture-preload.mjs",
      ".agents/skills/verify-research-shelf/scripts/motel.mjs",
    ])
      hashes[file] = hash(await readFile(path.join(root, file)));
    result.source = {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: execFileSync("git", ["status", "--short"], {
        cwd: root,
        encoding: "utf8",
      }),
      node: process.version,
      playwright: dep.playwright,
      executable: dep.executable,
      hashes,
      appSource:
        "examples/perplexity-demo copied without environment files or private state",
    };
    await launch(dep.next);
    browser = await chromium.launch({
      headless: true,
      executablePath: dep.executable,
    });
    result.source.browserVersion = browser.version();
    result.source.nextVersion = JSON.parse(
      await readFile(
        path.join(
          root,
          "examples/perplexity-demo/node_modules/next/package.json",
        ),
        "utf8",
      ),
    ).version;
    result.source.sdkVersion = JSON.parse(
      await readFile(
        path.join(
          root,
          "examples/perplexity-demo/node_modules/@opendatalabs/vana-sdk/package.json",
        ),
        "utf8",
      ),
    ).version;
    const context = await browser.newContext();
    await context.route("**/*", (route) =>
      guardedRoute(route, async () => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (
          url.origin === "https://app-dev.vana.org" &&
          url.pathname === "/data-connection-requests/dcr_shelf_verification"
        )
          return route.fulfill({
            contentType: "text/html",
            body: "<h1>Verification-only approval stand-in</h1><p>This is not Vana Web or Account.</p><button onclick=\"fetch('/verification-approve',{method:'POST'}).then(()=>document.body.append(' Fixture approved'))\">Approve fixture</button>",
          });
        if (
          url.origin === "https://app-dev.vana.org" &&
          url.pathname === "/verification-approve"
        ) {
          await fixture({ approval: "approved" });
          await event("fixture-approved");
          return route.fulfill({ contentType: "application/json", body: "{}" });
        }
        await event("browser-outbound-blocked", {
          origin: url.origin,
          pathname: url.pathname,
        });
        return route.abort("blockedbyclient");
      }),
    );
    const page = await context.newPage();
    activePage = page;
    phase = "initial-delivery";
    const ackRevisions = [];
    await page.route("**/api/acknowledge", (route) =>
      guardedRoute(route, async () => {
        const displayed = await page.evaluate(
          () => document.querySelector(".thread-list")?.textContent ?? null,
        );
        assert.equal(
          typeof displayed,
          "string",
          "acknowledgement was attempted before the saved DOM existed",
        );
        const saved = await connection();
        assert(saved.state.saved, "acknowledgement must follow a durable save");
        assert.equal(
          route.request().postDataJSON().revision,
          saved.state.saved.revision,
          "browser acknowledgement must name the durable revision",
        );
        assert(
          displayed.includes(saved.state.saved.threads[0].title),
          "acknowledgement must follow rendering of the saved revision",
        );
        await observer.observe({
          observer: "verifier",
          boundary: "browser",
          stage: "render",
          outcome: "ok",
          attempt: observer.attempt(),
          requestId: saved.state.requestId,
          grantId: saved.state.binding?.grantId,
          revision: saved.state.saved.revision,
          count: saved.state.saved.threads.length,
        });
        await event("browser-ack-request", {
          revision: saved.state.saved.revision,
          displayedHash: hash(displayed),
          persisted: true,
        });
        if (negative === "missing-save" && !result.clauses.initialDelivery) {
          const broken = { ...saved.state };
          delete broken.saved;
          await writeFile(saved.file, JSON.stringify(broken));
          await event("negative-control-removed-durable-save");
        }
        ackRevisions.push(route.request().postDataJSON().revision);
        return route.continue();
      }),
    );
    await page.goto(origin);
    await page.getByRole("heading", { name: "Research Shelf" }).waitFor();
    await page.getByText("No threads loaded.", { exact: true }).waitFor();
    const popupPromise = context.waitForEvent("page");
    await page
      .getByRole("button", { name: "Connect with Vana", exact: true })
      .click();
    const popup = await popupPromise;
    await popup.getByRole("button", { name: "Approve fixture" }).click();
    await until(
      async () => {
        const saved = await connection();
        assert(saved.state.saved, "saved revision is required");
        assert.equal(
          saved.state.acknowledged,
          saved.state.saved.revision,
          "delivery acknowledgement must match the saved revision",
        );
        assert(
          await page
            .getByRole("button", { name: "Read latest", exact: true })
            .isEnabled(),
        );
      },
      "Initial delivery must save, render and acknowledge",
      negative ? 7000 : 45000,
    );
    const initial = await connection();
    assert.equal(initial.state.saved.threads[0].title, state.title);
    assert.equal(
      await page.locator(".thread-list span").first().innerText(),
      state.title,
    );
    const initialRevision = initial.state.saved.revision;
    const binding = JSON.stringify(initial.state.binding);
    result.clauses.initialDelivery = {
      passed: true,
      revision: initialRevision,
      savedHash: hash(JSON.stringify(initial.state.saved.threads)),
      grantBindingHash: hash(binding),
      requestId: initial.state.requestId,
    };
    await page.screenshot({
      path: path.join(evidence, "initial-delivery.png"),
      fullPage: true,
    });
    phase = "same-grant-iteration";
    await fixture({
      approval: "completed",
      title: "Verifier changed conversation",
      version: 2,
      ackFailure: true,
    });
    await page
      .getByRole("button", { name: "Read latest", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .waitFor();
    const beforeRetry = await connection();
    assert.equal(beforeRetry.state.saved.threads[0].title, state.title);
    assert.notEqual(
      beforeRetry.state.acknowledged,
      beforeRetry.state.saved.revision,
    );
    const readsBeforeRetry = await servedCount();
    await fixture({ ackFailure: false });
    await page
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .click();
    await until(async () => {
      const saved = await connection();
      assert.notEqual(saved.state.saved.revision, initialRevision);
      assert.equal(saved.state.saved.threads[0].title, state.title);
      assert.equal(saved.state.acknowledged, saved.state.saved.revision);
      assert.equal(JSON.stringify(saved.state.binding), binding);
      assert.equal(
        await page.locator(".thread-list span").first().innerText(),
        state.title,
      );
    }, "Changed fixture delivery through the same grant");
    const changed = await connection();
    assert.equal(
      changed.state.saved.revision,
      beforeRetry.state.saved.revision,
      "confirmation retry must preserve the saved revision",
    );
    assert.equal(
      changed.state.saved.threads[0].id,
      initial.state.saved.threads[0].id,
      "iteration must preserve the record identity",
    );
    assert.equal(
      await servedCount(),
      readsBeforeRetry,
      "acknowledgement recovery must not reread data",
    );
    result.clauses.acknowledgementRecovery = {
      passed: true,
      readsBefore: readsBeforeRetry,
      readsAfter: await servedCount(),
      revision: changed.state.saved.revision,
    };
    result.clauses.sameGrantIteration = {
      passed: true,
      revision: changed.state.saved.revision,
      savedHash: hash(JSON.stringify(changed.state.saved.threads)),
      grantBindingHash: hash(binding),
      trigger: "Read latest",
      fixtureOnly: true,
    };
    await page.screenshot({
      path: path.join(evidence, "changed-delivery.png"),
      fullPage: true,
    });
    await fixture({ readFailure: true });
    phase = "failed-read-preservation";
    await page
      .getByRole("button", { name: "Read latest", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Your saved list is still available." })
      .waitFor();
    assert.equal(
      await page.locator(".thread-list span").first().innerText(),
      state.title,
    );
    assert.deepEqual((await connection()).state.saved, changed.state.saved);
    result.clauses.failedReadPreservesSaved = { passed: true };
    await fixture({ readFailure: false });
    phase = "reload-and-restart";
    const readsBeforeRestart = await servedCount();
    await page.reload();
    await page
      .getByRole("button", { name: "Read latest", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".thread-list span").first().innerText(),
      state.title,
    );
    await stopApp();
    await launch(dep.next);
    await page.reload();
    await page
      .getByRole("button", { name: "Read latest", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".thread-list span").first().innerText(),
      state.title,
    );
    assert.deepEqual((await connection()).state.saved, changed.state.saved);
    assert.equal(
      await servedCount(),
      readsBeforeRestart,
      "reload/restart must restore saved data without rereading",
    );
    await observer.observe({
      observer: "verifier",
      boundary: "browser",
      stage: "reload",
      outcome: "ok",
      attempt: observer.attempt(),
      requestId: changed.state.requestId,
      grantId: changed.state.binding?.grantId,
      revision: changed.state.saved.revision,
    });
    result.clauses.restartPersistence = {
      passed: true,
      revision: changed.state.saved.revision,
    };
    await page.screenshot({
      path: path.join(evidence, "restart-retention.png"),
      fullPage: true,
    });
    await writeFile(path.join(evidence, "rendered.html"), await page.content());
    await writeFile(
      path.join(evidence, "saved-state.json"),
      JSON.stringify((await connection()).state, null, 2),
    );
    result.clauses.acknowledgementAfterRender = {
      passed: true,
      revisions: ackRevisions,
    };
    assert.equal(
      (await serviceEvents()).filter(
        (entry) => entry.stage === "request-created",
      ).length,
      1,
      "iteration and recovery must not create replacement approval requests",
    );
    result.clauses.singleRequest = { passed: true, requestCount: 1 };
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.failureStage = phase;
    process.exitCode = phase === "setup" ? 2 : 1;
    if (activePage)
      await activePage
        .screenshot({
          path: path.join(evidence, "failure.png"),
          fullPage: true,
        })
        .catch(() => {});
  } finally {
    if (browser)
      await browser.close().catch((error) => {
        result.cleanup.browserError = error.message;
        result.passed = false;
        process.exitCode = 1;
      });
    await stopApp().catch((error) => {
      result.cleanup.processError = error.message;
      result.passed = false;
      process.exitCode = 1;
    });
    result.cleanup.ownedProcessStopped = stopped();
    result.cleanup.portReleased = await portClosed();
    if (!result.cleanup.portReleased || !result.cleanup.ownedProcessStopped) {
      result.passed = false;
      result.error ??=
        "Owned app process or port remains active after cleanup.";
      process.exitCode = 1;
    }
    await writeFile(
      path.join(evidence, "browser-events.json"),
      JSON.stringify(events, null, 2),
    );
    await writeFile(path.join(evidence, "app.log"), appLog);
    if (motel) {
      try {
        let observedFile = observationFile;
        if (negative === "missing-observations") {
          observedFile = path.join(evidence, "dropped-observations.jsonl");
          await writeFile(observedFile, "", { mode: 0o600 });
          result.productAssertionsPassedBeforeObservationControl =
            result.passed;
        }
        const observed = await exportAndQuery({
          file: observedFile,
          run: observationRun,
          endpoint: motel.endpoint,
          evidenceDir: path.join(evidence, "motel"),
        });
        const expected = {
          "save-failure": "save-failed-after-read",
          "ack-failure": "ack-failed-after-save-and-render",
          "read-interrupted": "read-interrupted-before-save",
          "missing-save": "ack-refused-missing-save",
        }[negative];
        result.motel.observations = observed.events.length;
        result.motel.diagnoses = observed.diagnoses;
        result.motel.coverage = observed.coverage;
        result.motel.successfulDeliveries = observed.successfulDeliveries;
        result.motel.expectedDiagnosis = expected ?? null;
        if (expected) {
          assert(
            observed.diagnoses.some((d) => d.diagnosis === expected),
            `Motel did not identify ${expected}`,
          );
        } else {
          assert(
            observed.successfulDeliveries.length >= 2,
            "Motel requires two linked successful read/save/render/ack chains",
          );
          assert(
            new Set(
              observed.successfulDeliveries.map((chain) => chain.revisionAlias),
            ).size >= 2,
            "Motel requires a changed delivered revision",
          );
          assert(
            new Set(
              observed.successfulDeliveries.map(
                (chain) => chain.requestAlias + chain.grantAlias,
              ),
            ).size === 1,
            "Motel deliveries must keep the same request and grant",
          );
          assert(
            observed.successfulDeliveries.some((chain) => chain.reloadEvidence),
            "Motel requires reload evidence linked after acknowledgement",
          );
          for (const stage of [
            "approval",
            "read",
            "save",
            "render",
            "ack",
            "reload",
          ])
            assert(
              observed.events.some((e) => e.stage === stage),
              `Motel has no ${stage} observation`,
            );
          assert(
            observed.diagnoses.some(
              (d) => d.diagnosis === "ack-failed-after-save-and-render",
            ),
            "Motel missed the recovered acknowledgement failure",
          );
        }
        result.motel.verified = true;
        if (negative === "missing-observations")
          throw new Error("Observation loss must not pass product acceptance");
      } catch (error) {
        result.motel.error = error.message;
        result.passed = false;
        result.error = `${result.error ?? "Product assertions completed"}; Motel: ${error.message}`;
        process.exitCode = 1;
      } finally {
        try {
          result.cleanup.motel = await motel.cleanup();
        } catch (error) {
          result.cleanup.motel = {
            owned: true,
            stopped: false,
            portReleased: false,
            error: error.message,
          };
          result.passed = false;
          process.exitCode = 1;
        }
        if (
          result.cleanup.motel.owned &&
          (!result.cleanup.motel.stopped || !result.cleanup.motel.portReleased)
        ) {
          result.passed = false;
          process.exitCode = 1;
        }
      }
    }
    await rm(runtime, { recursive: true, force: true });
    result.cleanup.runtimeRemoved = true;
    result.finishedAt = new Date().toISOString();
    if (interruptedSignal) {
      result.passed = false;
      process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
    }
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    await writeFile(
      path.join(evidence, "cleanup.json"),
      JSON.stringify(result.cleanup, null, 2),
    );
    await writeFile(
      path.join(evidence, "result.json"),
      JSON.stringify(result, null, 2),
    );
    await writeFile(
      path.join(evidence, "result.md"),
      `# Research Shelf controlled verification\n\nVerdict: ${result.passed ? "passed" : "failed"}.\n\n${result.error ?? "Actual app routes, browser rendering, durable saves and same-grant fixture iteration passed."}\n\nBlocked live claims:\n${result.blocked.map((claim) => `- ${claim}`).join("\n")}\n\nSee result.json, browser-events.json, events.jsonl and screenshots for evidence.\n`,
    );
    await stat(path.join(evidence, "result.json"));
    console.log(
      JSON.stringify({
        passed: result.passed,
        lane: result.lane,
        evidence,
        error: result.error,
        cleanup: result.cleanup,
      }),
    );
  }
}
