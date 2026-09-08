#!/usr/bin/env node
/**
 * Offline smoke test for the agent-facing `vana` CLI surface.
 *
 * Spawns the built CLI (dist/cli/bin.js) with a throwaway HOME under
 * os.tmpdir() so no real user state is touched. Covers:
 *
 *   version --json, telemetry status|disable|enable, data list, logs,
 *   schedule list (add/remove are launchd-touching and code-reviewed only),
 *   doctor, server status (read-only GET /health), skills list|install|show,
 *   mcp (JSON-RPC initialize + tools/list over stdio), logout, unknown cmd.
 *
 * Usage: node scripts/smoke-cli.mjs
 * Exit code: 0 when all checks pass, 1 otherwise.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const binPath = path.join(repoRoot, "dist", "cli", "bin.js");
const STALE_MS = 30 * 60 * 1000;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const baseDir = path.join(
  os.tmpdir(),
  `vana-cli-smoke-${process.pid}-${timestamp}`,
);
let homeDir;
let keepTempDir = false;

const checkTimeoutMs = 60_000;
const mcpTimeoutMs = 45_000;

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const marker = pass ? "PASS" : "FAIL";
  process.stdout.write(`[${marker}] ${name} — ${detail}\n`);
}

/**
 * Run the CLI with the temp HOME; resolve with { exitCode, stdout, stderr }.
 * Rejects on spawn error or timeout.
 */
function runVana(args, { timeoutMs = checkTimeoutMs, stdin = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      // Note: VANA_TELEMETRY_DISABLED is intentionally NOT set — it forces
      // telemetry state to "env_disabled" and would mask the toggle checks.
      env: {
        ...process.env,
        HOME: homeDir,
        VANA_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(`timeout after ${timeoutMs}ms: vana ${args.join(" ")}`),
        );
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      }
    });

    child.stdin.on("error", () => {
      // EPIPE if the child exits before consuming stdin — harmless here.
    });
    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

async function runCheck(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function failIf(cond, message) {
  if (cond) {
    throw new Error(message);
  }
}

function assertJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `stdout is not valid JSON: ${error.message}; stdout=${JSON.stringify(stdout.slice(0, 300))}`,
    );
  }
  return parsed;
}

function assertExitZero(result, args) {
  if (result.exitCode !== 0) {
    throw new Error(
      `exit ${result.exitCode} (expected 0); stderr=${JSON.stringify(result.stderr.slice(0, 300))}`,
    );
  }
  return args;
}

async function checkVersionJson() {
  const result = await runVana(["version", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(
    typeof json.cliVersion !== "string" || !json.cliVersion,
    "missing cliVersion",
  );
  failIf(
    !["stable", "beta", "latest", "preview"].includes(json.channel),
    `unexpected channel ${json.channel}`,
  );
  failIf(typeof json.installMethod !== "string", "missing installMethod");
  return `cliVersion=${json.cliVersion}, channel=${json.channel}`;
}

async function checkTelemetryStatus() {
  const result = await runVana(["telemetry", "status", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(typeof json.enabled !== "boolean", "missing enabled flag");
  failIf(
    typeof json.endpoint !== "string" || !json.endpoint,
    "missing endpoint",
  );
  return `enabled=${json.enabled}, endpoint=${json.endpoint}`;
}

async function checkTelemetryDisable() {
  const off = await runVana(["telemetry", "disable", "--json"]);
  assertExitZero(off);
  const offJson = assertJson(off.stdout);
  failIf(
    offJson.enabled !== false,
    `expected enabled=false, got ${JSON.stringify(offJson)}`,
  );

  const statusOff = await runVana(["telemetry", "status", "--json"]);
  assertExitZero(statusOff);
  failIf(
    assertJson(statusOff.stdout).enabled !== false,
    "status still enabled after disable",
  );
  return "disabled: enabled=false and status agrees";
}

async function checkTelemetryEnable() {
  const on = await runVana(["telemetry", "enable", "--json"]);
  assertExitZero(on);
  const onJson = assertJson(on.stdout);
  failIf(
    onJson.enabled !== true,
    `expected enabled=true, got ${JSON.stringify(onJson)}`,
  );

  const statusOn = await runVana(["telemetry", "status", "--json"]);
  assertExitZero(statusOn);
  failIf(
    assertJson(statusOn.stdout).enabled !== true,
    "status still disabled after enable",
  );
  return "enabled: enabled=true and status agrees";
}

async function checkTelemetryNoSpuriousMigrationNotice() {
  // First run creates ~/.vana; a second run must not claim data was moved
  // (no legacy ~/.dataconnect existed, only a compat symlink is created).
  const first = await runVana(["version", "--json"]);
  assertExitZero(first);
  const second = await runVana(["version", "--json"]);
  assertExitZero(second);
  failIf(
    second.stderr.includes("Moved your data"),
    `spurious migration notice on fresh HOME: ${JSON.stringify(second.stderr.slice(0, 200))}`,
  );
  return "no spurious 'Moved your data' notice on fresh HOME";
}

async function checkDataList() {
  const result = await runVana(["data", "list", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(json.count !== 0, `expected count=0 on fresh HOME, got ${json.count}`);
  failIf(
    !Array.isArray(json.datasets) || json.datasets.length !== 0,
    "datasets not empty",
  );
  return `count=0, datasets=${json.datasets.length}, nextSteps=${json.nextSteps.length}`;
}

async function checkLogs() {
  const result = await runVana(["logs", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(json.count !== 0, `expected count=0, got ${json.count}`);
  failIf(!Array.isArray(json.logs), "logs is not an array");
  return `count=0, logs=${json.logs.length}`;
}

async function checkScheduleList() {
  const result = await runVana(["schedule", "list", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(
    json.scheduled !== false,
    `expected scheduled=false on fresh HOME, got ${JSON.stringify(json)}`,
  );
  return "scheduled=false (nothing added; add/remove are launchd-touching)";
}

async function checkDoctor() {
  const result = await runVana(["doctor", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(typeof json.cliVersion !== "string", "missing cliVersion");
  failIf(
    !Array.isArray(json.checks) || json.checks.length === 0,
    "checks array empty",
  );
  failIf(
    !["available", "unavailable"].includes(json.personalServer),
    `personalServer=${json.personalServer}`,
  );
  const bad = json.checks.filter(
    (c) => !["ok", "warn", "error"].includes(c.status),
  );
  failIf(bad.length > 0, `checks with invalid status: ${JSON.stringify(bad)}`);
  const okCount = json.checks.filter((c) => c.status === "ok").length;
  return `cliVersion=${json.cliVersion}, personalServer=${json.personalServer}, ${okCount}/${json.checks.length} checks ok`;
}

async function checkServerStatus() {
  const result = await runVana(["server", "status", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(
    !["available", "unavailable"].includes(json.state),
    `unexpected state=${json.state}`,
  );
  failIf(!("url" in json), "missing url field");
  return `state=${json.state}, url=${json.url ?? "null"}, scopeCount=${json.scopeCount ?? 0}`;
}

async function checkSkillsList() {
  const result = await runVana(["skills", "list", "--json"]);
  assertExitZero(result);
  const json = assertJson(result.stdout);
  failIf(
    !Number.isInteger(json.count) || json.count < 1,
    `count=${json.count}`,
  );
  failIf(
    !Array.isArray(json.skills) || json.skills.length !== json.count,
    "skills/count mismatch",
  );
  const ids = json.skills.map((s) => s.id).filter((id) => !id);
  failIf(ids.length > 0, "skill missing id");
  return `count=${json.count}, ids=${json.skills.map((s) => s.id).join(",")}`;
}

async function checkSkillsInstall() {
  const result = await runVana(["skills", "install", "connect-data"]);
  assertExitZero(result);
  failIf(
    !/installed/i.test(result.stdout),
    `stdout=${JSON.stringify(result.stdout.slice(0, 200))}`,
  );

  const skillFile = path.join(
    homeDir,
    ".agents",
    "skills",
    "vana-connect-data",
    "SKILL.md",
  );
  const info = await stat(skillFile).catch(() => null);
  failIf(
    !info || info.size === 0,
    `skill file missing or empty at ${skillFile}`,
  );

  const listAfter = await runVana(["skills", "list", "--json"]);
  assertExitZero(listAfter);
  const installed = assertJson(listAfter.stdout).skills.find(
    (s) => s.id === "connect-data",
  );
  failIf(
    !installed || installed.installed !== true,
    "connect-data not flagged installed",
  );

  const badInstall = await runVana([
    "skills",
    "install",
    "no-such-skill",
    "--json",
  ]);
  failIf(
    badInstall.exitCode === 0,
    "unknown skill install should exit non-zero",
  );
  const badJson = assertJson(badInstall.stdout);
  failIf(
    badJson.ok !== false,
    `expected ok=false, got ${JSON.stringify(badJson)}`,
  );

  return `SKILL.md=${info.size}B in ~/.agents/skills/vana-connect-data; unknown-skill path ok`;
}

async function checkMcp() {
  const home = homeDir;
  const rpc = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, "mcp"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        VANA_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const pending = new Map();
    const serverLines = [];

    let exitCode = null;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else {
        resolve({ exitCode, serverLines, stderr });
      }
    };

    let timer = setTimeout(() => {
      finish(new Error(`mcp timeout after ${mcpTimeoutMs}ms`));
    }, mcpTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          // stdout is the JSON-RPC transport — anything else is a bug.
          finish(
            new Error(
              `mcp stdout contains non-JSON-RPC line: ${JSON.stringify(trimmed.slice(0, 200))}`,
            ),
          );
          return;
        }
        serverLines.push(trimmed);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      finish(new Error(`spawn failed: ${error.message}`)),
    );
    child.on("close", (code) => {
      exitCode = code;
    });

    const request = (id, method, params) => {
      return new Promise((res, rej) => {
        pending.set(id, (message) => {
          pending.delete(id);
          if (message.error) {
            rej(
              new Error(
                `json-rpc error for ${method}: ${JSON.stringify(message.error)}`,
              ),
            );
            return;
          }
          res(message.result);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    };

    (async () => {
      try {
        const init = await request(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke-cli", version: "0.0.0" },
        });
        if (init.serverInfo?.name !== "vana") {
          throw new Error(`unexpected serverInfo: ${JSON.stringify(init)}`);
        }
        if (!init.protocolVersion) {
          throw new Error("initialize missing protocolVersion");
        }
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
        );
        const tools = await request(2, "tools/list", {});
        if (!Array.isArray(tools.tools) || tools.tools.length < 6) {
          throw new Error(
            `expected >=6 tools, got ${JSON.stringify(tools.tools?.map?.((t) => t.name))}`,
          );
        }
        const names = tools.tools.map((t) => t.name);
        const expected = [
          "check_status",
          "list_sources",
          "show_data",
          "connect_source",
          "run_diagnostics",
        ];
        const missing = expected.filter((n) => !names.includes(n));
        if (missing.length > 0)
          throw new Error(`missing tools: ${missing.join(",")}`);
        for (const tool of tools.tools) {
          if (!tool.inputSchema)
            throw new Error(`tool ${tool.name} missing inputSchema`);
        }
        // Close stdin so the server exits cleanly; wait for the close event.
        child.stdin.end();
        const deadline = Date.now() + 10_000;
        while (exitCode === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (exitCode === null)
          throw new Error("mcp server did not exit after stdin closed");
        finish(null);
      } catch (error) {
        finish(error);
      }
    })();
  });

  if (rpc.exitCode !== 0) {
    throw new Error(
      `mcp exited ${rpc.exitCode} after stdin closed (expected 0); stderr=${JSON.stringify(rpc.stderr.slice(0, 300))}`,
    );
  }
  if (/unsettled top-level await/i.test(rpc.stderr)) {
    throw new Error("mcp exited with unsettled top-level await warning");
  }
  const initLine = JSON.parse(
    rpc.serverLines.find((l) => JSON.parse(l).id === 1),
  );
  const toolsLine = JSON.parse(
    rpc.serverLines.find((l) => JSON.parse(l).id === 2),
  );
  return `serverInfo=${initLine.result.serverInfo.name}@${initLine.result.serverInfo.version}, tools=${toolsLine.result.tools.map((t) => t.name).join(",")}, clean exit 0`;
}

async function checkLogout() {
  const result = await runVana(["logout"]);
  assertExitZero(result);
  failIf(
    !/logged out/i.test(result.stdout + result.stderr),
    `stdout=${JSON.stringify(result.stdout.slice(0, 200))}`,
  );
  const json = await runVana(["version", "--json"]);
  assertExitZero(json);
  return "logged out (no creds in temp HOME; JSON still valid)";
}

async function checkUnknownCommand() {
  const result = await runVana(["bogus"]);
  failIf(result.exitCode === 0, "unknown command should exit non-zero");
  failIf(
    !/unknown command/i.test(result.stderr),
    `stderr=${JSON.stringify(result.stderr.slice(0, 200))}`,
  );
  const stackTrace = /at .+ \(.+:\d+:\d+\)/m.test(
    result.stdout + result.stderr,
  );
  failIf(stackTrace, "stack trace printed for unknown command");
  return `exit=${result.exitCode}, friendly error, no stack trace`;
}

async function main() {
  fsCheck();
  await mkdir(path.join(baseDir), { recursive: true });
  homeDir = path.join(baseDir, "home");
  await mkdir(homeDir, { recursive: true });

  process.stdout.write(`smoke-cli: ${binPath}\ntemp HOME: ${homeDir}\n\n`);

  // Order matters: the migration-notice check needs a genuinely fresh HOME,
  // so it runs before anything else creates ~/.vana.
  const checks = [
    [
      "no spurious HOME migration notice",
      checkTelemetryNoSpuriousMigrationNotice,
    ],
    ["version --json", checkVersionJson],
    ["telemetry status --json", checkTelemetryStatus],
    ["telemetry disable --json", checkTelemetryDisable],
    ["telemetry enable --json", checkTelemetryEnable],
    ["data list --json", checkDataList],
    ["logs --json", checkLogs],
    ["schedule list --json", checkScheduleList],
    ["doctor --json", checkDoctor],
    ["server status --json (read-only)", checkServerStatus],
    ["skills list --json", checkSkillsList],
    ["skills install + failure path", checkSkillsInstall],
    ["mcp initialize + tools/list", checkMcp],
    ["logout", checkLogout],
    ["unknown command", checkUnknownCommand],
  ];

  for (const [name, fn] of checks) {
    await runCheck(name, fn);
  }

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((f) => f.name).join(", ")}\n`);
  }

  if (failed.length > 0) {
    keepTempDir = true;
    process.stdout.write(`temp HOME kept for inspection: ${baseDir}\n`);
  } else {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
  return failed.length;
}

function fsCheck() {
  if (!existsSync(binPath)) {
    throw new Error(
      `built CLI not found at ${binPath} — run: COREPACK_HOME=$PWD/.corepack pnpm build`,
    );
  }
}

main().then(
  (failedCount) => process.exit(failedCount > 0 ? 1 : 0),
  (error) => {
    process.stderr.write(`smoke-cli setup failed: ${error.stack ?? error}\n`);
    if (keepTempDir) return;
    rm(baseDir, { recursive: true, force: true }).finally(() =>
      process.exit(1),
    );
  },
);
