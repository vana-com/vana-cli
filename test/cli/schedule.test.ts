import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyCollectedSource,
  collectAllExitCode,
  describeCollectAllFailures,
  describeScheduledRun,
  diagnoseSchedule,
  generateCrontabEntry,
  generateLaunchdPlist,
  parseCrontabEntry,
  parseLaunchdPlist,
  resolveScheduleTarget,
} from "../../src/cli/schedule.js";
import type { ScheduleDeps } from "../../src/cli/index.js";
import { CliExitCode } from "../../src/core/exit-codes.js";

const NODE = "/Users/x/.nvm/versions/node/v24.14.1/bin/node";
const BIN =
  "/Users/x/.nvm/versions/node/v24.14.1/lib/node_modules/vana-cli/bin/vana";

/** The plist `vana schedule add` wrote from a shell with VANA_HOME=/tmp/... */
function legacyPlist(intervalSeconds = 86400): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vana.collect</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${BIN}</string>
    <string>collect</string>
    <string>--all</string>
    <string>--quiet</string>
    <string>--no-input</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>/tmp/vana-mainnet/.vana/logs/schedule.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vana-mainnet/.vana/logs/schedule.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

describe("schedule target", () => {
  it("pins the creating shell's state, network and server, never its secrets", () => {
    const target = resolveScheduleTarget({
      VANA_HOME: "/tmp/vana-mainnet/.vana/",
      VANA_NETWORK: "mainnet",
      VANA_ACCOUNT_URL: "https://account.example",
      VANA_PS_URL: "https://ps.example",
      VANA_PS_TOKEN: "secret",
      VANA_SESSION_TOKEN: "secret",
      VANA_PRIVATE_KEY: "0xsecret",
    });

    expect(target.home).toBe("/tmp/vana-mainnet/.vana");
    expect(target.logPath).toBe("/tmp/vana-mainnet/.vana/logs/schedule.log");
    expect(target.env).toEqual({
      VANA_HOME: "/tmp/vana-mainnet/.vana",
      VANA_NETWORK: "mainnet",
      VANA_ACCOUNT_URL: "https://account.example",
      VANA_PS_URL: "https://ps.example",
      VANA_SCHEDULED_RUN: "1",
    });
  });

  it("pins the default home explicitly and lets --network win", () => {
    const target = resolveScheduleTarget(
      { VANA_NETWORK: "moksha" },
      "mainnet",
      "/Users/x",
    );
    expect(target.home).toBe("/Users/x/.vana");
    expect(target.logPath).toBe("/Users/x/.vana/logs/schedule.log");
    expect(target.env.VANA_HOME).toBe("/Users/x/.vana");
    expect(target.env.VANA_NETWORK).toBe("mainnet");
  });

  it("writes a plist whose env and log name the same state, and reads it back", () => {
    const target = resolveScheduleTarget({
      VANA_HOME: "/tmp/a & b/.vana",
      VANA_NETWORK: "mainnet",
    });
    const plist = generateLaunchdPlist([NODE, BIN], 43200, target);

    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<string>/tmp/a &amp; b/.vana</string>");
    expect(parseLaunchdPlist(plist)).toEqual({
      intervalSeconds: 43200,
      logPath: "/tmp/a & b/.vana/logs/schedule.log",
      env: target.env,
    });
    expect(
      diagnoseSchedule(parseLaunchdPlist(plist), target.home).drift,
    ).toEqual([]);
  });

  it("puts the pinned env in front of the cron command, and reads it back", () => {
    const target = resolveScheduleTarget({ VANA_HOME: "/home/o'neil/.vana" });
    const line = generateCrontabEntry([NODE, BIN], 1, target);

    expect(line).toMatch(
      /^0 \*\/1 \* \* \* VANA_HOME='\/home\/o'\\''neil\/\.vana' /,
    );
    expect(line).toContain(
      `>> '/home/o'\\''neil/.vana/logs/schedule.log' 2>&1 # vana-scheduled-collection`,
    );
    expect(parseCrontabEntry(line)).toEqual({
      intervalSeconds: 3600,
      logPath: "/home/o'neil/.vana/logs/schedule.log",
      env: target.env,
    });
  });

  it("flags the observed plist: log in a /tmp home, job in the real one", () => {
    const { jobHome, drift } = diagnoseSchedule(
      parseLaunchdPlist(legacyPlist()),
      "/Users/x/.vana",
      "/Users/x",
    );
    expect(jobHome).toBe("/Users/x/.vana");
    expect(drift.map((d) => d.kind)).toEqual([
      "log_outside_home",
      "home_not_pinned",
    ]);
  });
});

describe("schedule commands", () => {
  let dir: string;
  let stdout: string;
  let commands: string[];
  let crontab: string;

  function deps(
    platform: NodeJS.Platform,
    env: Record<string, string | undefined>,
  ): ScheduleDeps {
    return {
      platform,
      plistPath: path.join(dir, "LaunchAgents", "com.vana.collect.plist"),
      env,
      exec: (command, input) => {
        commands.push(command);
        if (command.startsWith("crontab -l")) return crontab;
        if (command === "crontab -") crontab = input ?? "";
        return "";
      },
      resolveCommand: () => [NODE, BIN],
      readFile: (p) => fs.readFile(p, "utf8"),
      writeFile: (p, c) => fs.writeFile(p, c),
      mkdir: async (p) => {
        await fs.mkdir(p, { recursive: true });
      },
      unlink: (p) => fs.unlink(p),
    };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vana-schedule-test-"));
    stdout = "";
    commands = [];
    crontab = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("add pins VANA_HOME and logs inside it; a second add changes nothing", async () => {
    const { runScheduleAdd } = await import("../../src/cli/index.js");
    const home = path.join(dir, "state");
    const d = deps("darwin", { VANA_HOME: home, VANA_NETWORK: "mainnet" });

    expect(await runScheduleAdd(undefined, { json: true }, d)).toBe(0);
    const first = JSON.parse(stdout);
    expect(first).toMatchObject({
      action: "added",
      home,
      logPath: path.join(home, "logs", "schedule.log"),
    });
    const plist = parseLaunchdPlist(await fs.readFile(d.plistPath, "utf8"));
    expect(plist.env).toMatchObject({
      VANA_HOME: home,
      VANA_NETWORK: "mainnet",
      VANA_SCHEDULED_RUN: "1",
    });
    expect(plist.logPath).toBe(path.join(home, "logs", "schedule.log"));
    await expect(fs.stat(path.join(home, "logs"))).resolves.toBeTruthy();
    expect(commands).toEqual([
      `launchctl unload "${d.plistPath}" 2>/dev/null`,
      `launchctl load "${d.plistPath}"`,
    ]);

    stdout = "";
    commands = [];
    expect(await runScheduleAdd(undefined, { json: true }, d)).toBe(0);
    expect(JSON.parse(stdout).action).toBe("unchanged");
    expect(commands).toEqual([]);
  });

  it("add repairs an outdated plist, keeps its interval and says what was wrong", async () => {
    const { runScheduleAdd } = await import("../../src/cli/index.js");
    const d = deps("darwin", {});
    await fs.mkdir(path.dirname(d.plistPath), { recursive: true });
    await fs.writeFile(d.plistPath, legacyPlist(43200));

    expect(await runScheduleAdd(undefined, {}, d)).toBe(0);
    expect(stdout).toContain("Repaired the every 12h collection schedule.");
    expect(stdout).toContain(
      "/tmp/vana-mainnet/.vana/logs/schedule.log, outside the state it collects into",
    );

    const home = path.join(os.homedir(), ".vana");
    const plist = parseLaunchdPlist(await fs.readFile(d.plistPath, "utf8"));
    expect(plist.intervalSeconds).toBe(43200);
    expect(plist.env.VANA_HOME).toBe(home);
    expect(plist.logPath).toBe(path.join(home, "logs", "schedule.log"));
  });

  it("list shows the state and log, and warns about an outdated plist", async () => {
    const { runScheduleList } = await import("../../src/cli/index.js");
    const d = deps("darwin", {});
    await fs.mkdir(path.dirname(d.plistPath), { recursive: true });
    await fs.writeFile(d.plistPath, legacyPlist());

    expect(await runScheduleList({ json: true }, d)).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      scheduled: true,
      home: path.join(os.homedir(), ".vana"),
      logPath: "/tmp/vana-mainnet/.vana/logs/schedule.log",
      outdated: true,
    });
    expect(parsed.warnings.map((w: { kind: string }) => w.kind)).toEqual([
      "log_outside_home",
      "home_not_pinned",
    ]);

    stdout = "";
    await runScheduleList({}, d);
    expect(stdout).toContain("State: ~/.vana");
    expect(stdout).toContain("Log: /tmp/vana-mainnet/.vana/logs/schedule.log");
    expect(stdout).toContain("Warning: It logs to /tmp/vana-mainnet");
    expect(stdout).toContain("vana schedule add");
  });

  it("list tells a shell on another state which state the job serves", async () => {
    const { runScheduleAdd, runScheduleList } =
      await import("../../src/cli/index.js");
    const jobHome = path.join(dir, "job");
    await runScheduleAdd(
      undefined,
      { json: true },
      deps("darwin", { VANA_HOME: jobHome }),
    );

    stdout = "";
    await runScheduleList(
      { json: true },
      deps("darwin", { VANA_HOME: path.join(dir, "other") }),
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.outdated).toBe(false);
    expect(parsed.home).toBe(jobHome);
    expect(parsed.warnings.map((w: { kind: string }) => w.kind)).toEqual([
      "other_home",
    ]);
  });

  it("cron: add replaces only our line and pins the state", async () => {
    const { runScheduleAdd, runScheduleList } =
      await import("../../src/cli/index.js");
    crontab = `5 4 * * * /usr/bin/backup\n0 */1 * * * '/usr/bin/node' 'vana' collect --all --quiet --no-input >> '/tmp/x/.vana/logs/schedule.log' 2>&1 # vana-scheduled-collection\n`;
    const home = path.join(dir, "state");
    const d = deps("linux", { VANA_HOME: home });

    expect(await runScheduleAdd(undefined, { json: true }, d)).toBe(0);
    expect(JSON.parse(stdout).action).toBe("repaired");
    const lines = crontab.trim().split("\n");
    expect(lines[0]).toBe("5 4 * * * /usr/bin/backup");
    expect(lines).toHaveLength(2);
    expect(parseCrontabEntry(lines[1])).toMatchObject({
      logPath: path.join(home, "logs", "schedule.log"),
      env: { VANA_HOME: home, VANA_SCHEDULED_RUN: "1" },
    });

    stdout = "";
    await runScheduleList({ json: true }, d);
    expect(JSON.parse(stdout)).toMatchObject({
      mechanism: "cron",
      home,
      outdated: false,
      warnings: [],
    });
  });
});

describe("collect --all outcome", () => {
  it("counts a run whose sync failed as failed, though runConnect exited 0", () => {
    expect(
      classifyCollectedSource("github", 0, {
        dataState: "ingest_failed",
        lastRunOutcome: "ingest_failed",
        lastError: "HTTP 401",
      }),
    ).toEqual({ source: "github", outcome: "sync_failed", error: "HTTP 401" });
    expect(
      classifyCollectedSource("github", 0, {
        dataState: "ingested_personal_server",
        ingestScopes: [
          { scope: "a", status: "stored" },
          { scope: "b", status: "failed", error: "HTTP 500" },
        ],
      }),
    ).toEqual({ source: "github", outcome: "sync_failed", error: "HTTP 500" });
    expect(
      classifyCollectedSource("github", 0, { dataState: "ingest_unavailable" })
        .outcome,
    ).toBe("sync_pending");
    expect(classifyCollectedSource("github", 1, {}).outcome).toBe(
      "collect_failed",
    );
    expect(
      classifyCollectedSource("github", 0, {
        dataState: "ingested_personal_server",
      }).outcome,
    ).toBe("ok");
  });

  it("exits OK only when everything synced; 5 when no server answered", () => {
    expect(collectAllExitCode([])).toBe(CliExitCode.OK);
    expect(collectAllExitCode([{ source: "a", outcome: "ok" }])).toBe(
      CliExitCode.OK,
    );
    expect(
      collectAllExitCode([
        { source: "a", outcome: "ok" },
        { source: "b", outcome: "sync_pending" },
      ]),
    ).toBe(CliExitCode.SERVER_UNAVAILABLE);
    expect(
      collectAllExitCode([
        { source: "a", outcome: "sync_pending" },
        { source: "b", outcome: "sync_failed" },
      ]),
    ).toBe(CliExitCode.FAILURE);
    expect(
      collectAllExitCode([{ source: "a", outcome: "collect_failed" }]),
    ).toBe(CliExitCode.FAILURE);
  });

  it("names each failed source for the log", () => {
    expect(
      describeCollectAllFailures([
        { source: "a", outcome: "ok" },
        { source: "b", outcome: "sync_failed", error: "HTTP 401" },
      ]),
    ).toEqual([
      "1 of 2 source(s) did not collect and sync:",
      "  b: sync failed (HTTP 401)",
    ]);
    expect(
      describeCollectAllFailures([{ source: "a", outcome: "ok" }]),
    ).toEqual([]);
  });
});

describe("last scheduled run", () => {
  const base = {
    startedAt: "2026-10-06T04:12:00.000Z",
    finishedAt: "2026-10-06T04:13:00.000Z",
    logPath: "/Users/x/.vana/logs/schedule.log",
  };
  const at = () => "Oct 6 9:13 p.m.";

  it("is one short clause when it went fine", () => {
    expect(
      describeScheduledRun(
        { ...base, exitCode: 0, sources: [{ source: "a", outcome: "ok" }] },
        at,
      ),
    ).toEqual({ text: "Oct 6 9:13 p.m., ok", failed: false });
    expect(
      describeScheduledRun({ ...base, exitCode: 0, sources: [] }, at),
    ).toEqual({ text: "Oct 6 9:13 p.m., nothing was due", failed: false });
  });

  it("counts the failures and points at the log when it did not", () => {
    const sources = ["a", "b", "c", "d", "e", "f"].map((source) => ({
      source,
      outcome: "sync_failed" as const,
    }));
    expect(describeScheduledRun({ ...base, exitCode: 1, sources }, at)).toEqual(
      {
        text: "Oct 6 9:13 p.m., 6 of 6 failed to sync (see /Users/x/.vana/logs/schedule.log)",
        failed: true,
      },
    );
  });

  it("is kept in the state file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vana-state-test-"));
    const previous = process.env.VANA_HOME;
    process.env.VANA_HOME = home;
    try {
      const { recordScheduledRun, readCliState, updateSourceState } =
        await import("../../src/core/state-store.js");
      await updateSourceState("github", { dataState: "ingest_failed" });
      const record = {
        ...base,
        exitCode: 1,
        sources: [{ source: "github", outcome: "sync_failed" as const }],
      };
      await recordScheduledRun(record);
      const state = await readCliState();
      expect(state.lastScheduledRun).toEqual(record);
      expect(state.sources.github?.dataState).toBe("ingest_failed");
    } finally {
      if (previous === undefined) delete process.env.VANA_HOME;
      else process.env.VANA_HOME = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
