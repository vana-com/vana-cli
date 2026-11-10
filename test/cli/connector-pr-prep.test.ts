import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/index.js";

let root: string;
let checkout: string;
let base: string;
let head: string;
let previousExitCode: typeof process.exitCode;

function git(...args: string[]) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
}

function commit() {
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--signoff",
    "-m",
    "Fixture change",
  );
  return git("rev-parse", "HEAD").trim();
}

function writeConnector(version: string, otherVersion = "1.0.0") {
  const manifest = {
    connector_key: "example",
    version,
    streams: [{ name: "items" }],
  };
  writeFileSync(
    path.join(checkout, "connectors/example/manifest.json"),
    JSON.stringify(manifest),
  );
  writeFileSync(
    path.join(checkout, "connector-implementation-index.json"),
    JSON.stringify({
      version: 1,
      connectors: [
        { entry: "./connectors/example/index.ts", manifest },
        {
          entry: "./connectors/other/index.ts",
          manifest: { connector_key: "other", version: otherVersion },
        },
      ],
    }),
  );
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  root = mkdtempSync(path.join(os.tmpdir(), "vana-prepare-pr-"));
  checkout = path.join(root, "data-connectors");
  mkdirSync(path.join(checkout, "connectors/example"), { recursive: true });
  vi.stubEnv("VANA_HOME", path.join(root, "vana"));
  git("init", "--quiet");
  writeConnector("1.0.0");
  writeFileSync(
    path.join(checkout, "connectors/example/index.ts"),
    "export const test = 'before';\n",
  );
  base = commit();
  writeConnector("1.0.1");
  writeFileSync(
    path.join(checkout, "connectors/example/index.ts"),
    "export const test = 'after';\n",
  );
  head = commit();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
  rmSync(root, { recursive: true, force: true });
});

async function preview(
  evidenceCommit: string,
  command = "prepare-pr",
  ...args: string[]
) {
  const evidence = path.join(root, "synthetic.json");
  writeFileSync(
    evidence,
    JSON.stringify({
      kind: "synthetic",
      commit: evidenceCommit,
      checkedAt: "2026-11-10T00:00:00Z",
      checks: [{ name: "Fixture test", result: "passed" }],
    }),
  );
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const code = await runCli([
    "node",
    "vana",
    "connectors",
    command,
    "example",
    "--checkout",
    checkout,
    "--base",
    base,
    "--summary",
    "Fix example.",
    "--evidence",
    evidence,
    "--json",
    ...args,
  ]);
  const result = JSON.parse(
    stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
  );
  stdout.mockRestore();
  return { code, result };
}

it("previews the committed change and evidence without including or modifying dirty files", async () => {
  const entry = path.join(checkout, "connectors/example/index.ts");
  writeFileSync(entry, "export const test = 'uncommitted';\n");
  git("add", "connectors/example/index.ts");
  writeFileSync(path.join(checkout, "private.txt"), "private example data");
  const statusBefore = git("status", "--porcelain");
  const { code, result } = await preview(head);

  expect(code).toBe(0);
  expect(result).toMatchObject({
    target: "https://github.com/PDP-Connect/data-connectors",
    base,
    head,
    connector: "example",
    version: "1.0.1",
    files: [
      "connector-implementation-index.json",
      "connectors/example/index.ts",
      "connectors/example/manifest.json",
    ],
  });
  expect(result.diff).toContain("+export const test = 'after';");
  expect(result.diff).not.toContain("uncommitted");
  expect(result.diff).not.toContain("private.txt");
  expect(result.prBody).toContain("Reported synthetic checks");
  expect(result.prBody).toContain("Fixture test — passed");
  expect(git("status", "--porcelain")).toBe(statusBefore);
  expect(git("rev-parse", "HEAD").trim()).toBe(head);
});

it("rejects evidence for another commit without emitting a patch", async () => {
  const { code, result } = await preview(base);

  expect(code).toBe(1);
  expect(result.error.code).toBe("stale_evidence");
  expect(result).not.toHaveProperty("diff");
});

it("rejects another connector's change in the shared implementation index", async () => {
  writeConnector("1.0.1", "1.0.1");
  head = commit();
  const { code, result } = await preview(head);

  expect(code).toBe(1);
  expect(result.error.code).toBe("unrelated_index_change");
  expect(result).not.toHaveProperty("diff");
});

it("rejects unrelated committed files rather than hiding them from the preview", async () => {
  writeFileSync(path.join(checkout, "unrelated.txt"), "out of scope");
  head = commit();
  const { code, result } = await preview(head);

  expect(code).toBe(1);
  expect(result.error.code).toBe("connector_diff_required");
  expect(result).not.toHaveProperty("diff");
});

function githubFixture() {
  const bin = path.join(root, "bin");
  const fork = path.join(root, "fork.git");
  const receipt = path.join(root, "pull.json");
  const writes = path.join(root, "write-attempts.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  execFileSync(realGit, ["init", "--quiet", "--bare", fork]);
  mkdirSync(bin);
  vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  vi.stubEnv("VANA_TEST_BASE", base);
  vi.stubEnv("VANA_TEST_REAL_GIT", realGit);
  vi.stubEnv("VANA_TEST_FORK", fork);
  vi.stubEnv("VANA_TEST_RECEIPT", receipt);
  vi.stubEnv("VANA_TEST_WRITES", writes);
  vi.stubEnv("VANA_TEST_LOGIN", "fixture-builder");
  vi.stubEnv("GH_TOKEN", "ambient-ci-token");
  vi.stubEnv("GITHUB_TOKEN", "ambient-collection-token");
  writeFileSync(
    path.join(bin, "git"),
    String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const remote = args.indexOf("https://github.com/fixture-builder/data-connectors.git");
if (args.includes("push")) {
  require("node:fs").appendFileSync(process.env.VANA_TEST_WRITES, "push\n");
  if (process.env.VANA_TEST_FORK_READ_ONLY) process.exit(1);
  if (remote === -1 || process.env.GH_TOKEN !== "fixture-only-token") process.exit(1);
  args[remote] = process.env.VANA_TEST_FORK;
}
const result = spawnSync(process.env.VANA_TEST_REAL_GIT, args, {
  env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "gh"),
    String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const env = process.env;
const args = process.argv.slice(2);
const root = "repos/PDP-Connect/data-connectors";
const login = env.VANA_TEST_LOGIN;
const receipt = env.VANA_TEST_RECEIPT;
const createRequest = args.includes(root + "/pulls") && args.includes("POST");
if (createRequest || (args[0] === "pr" && args[1] === "create")) {
  fs.appendFileSync(env.VANA_TEST_WRITES, "create PR\n");
}
const send = (data) => process.stdout.write(JSON.stringify(data));
if (env.GITHUB_TOKEN || (env.GH_TOKEN && env.GH_TOKEN !== "fixture-only-token")) {
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "token" && args.includes(login)) {
  process.stdout.write("fixture-only-token");
} else if (args.includes("user") && login) {
  process.stdout.write(login);
} else if (args.includes("repos/" + login + "/data-connectors")) {
  send({
    full_name: login + "/data-connectors",
    private: false,
    parent: { full_name: "PDP-Connect/data-connectors" },
    permissions: { push: true },
  });
} else if (args.includes(root + "/git/ref/heads/main")) {
  send({ object: { sha: env.VANA_TEST_BASE } });
} else if (createRequest) {
  if (fs.existsSync(receipt)) throw new Error("Duplicate create");
  const submitted = JSON.parse(fs.readFileSync(0, "utf8"));
  const branch = submitted.head.slice(login.length + 1);
  const pushed = execFileSync(env.VANA_TEST_REAL_GIT, [
    "--git-dir", env.VANA_TEST_FORK, "rev-parse", "refs/heads/" + branch,
  ], { encoding: "utf8" }).trim();
  const pr = {
    number: 42,
    html_url: "https://github.com/PDP-Connect/data-connectors/pull/42",
    state: "open",
    draft: submitted.draft,
    merged_at: null,
    user: { login },
    head: { sha: pushed, label: submitted.head },
    base: { ref: submitted.base },
  };
  fs.writeFileSync(receipt, JSON.stringify({ submitted, pr }));
  if (env.VANA_TEST_LOSE_RESPONSE) process.exit(1);
  send(pr);
} else if (args.includes(root + "/pulls/42")) {
  send(JSON.parse(fs.readFileSync(receipt, "utf8")).pr);
} else if (args.some((arg) => arg.startsWith(root + "/pulls?"))) {
  const query = new URLSearchParams(args.find((arg) => arg.includes("/pulls?")).split("?")[1]);
  const pr = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")).pr : null;
  if (pr && env.VANA_TEST_LOSE_RESPONSE === "and-lookup") process.exit(1);
  send(pr && query.get("head") === pr.head.label && query.get("base") === pr.base.ref &&
    query.get("state") === "all" ? [{ number: pr.number }] : []);
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return {
    receipt,
    writeAttempts: () => readFileSync(writes, "utf8"),
    refs: () =>
      execFileSync(
        realGit,
        ["--git-dir", fork, "for-each-ref", "--format=%(objectname)"],
        {
          encoding: "utf8",
        },
      ).trim(),
  };
}

const withShellFixtures = it.skipIf(process.platform === "win32");

withShellFixtures(
  "requires a GitHub login and explicit confirmation bound to the public preview",
  async () => {
    const fixture = githubFixture();
    vi.stubEnv("VANA_TEST_LOGIN", "");
    const signedOut = await preview(head, "submit-pr");
    expect(signedOut).toMatchObject({
      code: 7,
      result: { error: { code: "github_sign_in_required" } },
    });

    vi.stubEnv("VANA_TEST_LOGIN", "fixture-builder");
    const reviewed = await preview(head, "submit-pr", "--yes");
    expect(reviewed).toMatchObject({
      code: 7,
      result: {
        kind: "confirmation_required",
        login: "fixture-builder",
        fork: "https://github.com/fixture-builder/data-connectors",
        target: "https://github.com/PDP-Connect/data-connectors",
        title: "Fix example.",
      },
    });
    expect(reviewed.result.diff).toContain("+export const test = 'after';");
    expect(reviewed.result.prBody).toContain("Fixture test — passed");

    vi.stubEnv("VANA_TEST_LOGIN", "another-account");
    const changed = await preview(
      head,
      "submit-pr",
      "--confirm",
      reviewed.result.confirmation,
    );
    expect(changed).toMatchObject({
      code: 7,
      result: { error: { code: "confirmation_mismatch" } },
    });
    expect(fixture.refs()).toBe("");
    expect(existsSync(fixture.receipt)).toBe(false);
  },
);

withShellFixtures.each(["no loss", "response", "and-lookup"])(
  "returns one draft PR when creating or recovering a submission (%s)",
  async (loss) => {
    const fixture = githubFixture();
    const reviewed = await preview(head, "submit-pr");
    vi.stubEnv("VANA_TEST_LOSE_RESPONSE", loss === "no loss" ? "" : loss);
    writeFileSync(
      path.join(checkout, "private.txt"),
      "uncommitted private data",
    );

    const confirmed = await preview(
      head,
      "submit-pr",
      "--confirm",
      reviewed.result.confirmation,
    );
    if (loss === "and-lookup") {
      expect(confirmed.code).toBe(1);
    } else {
      expect(confirmed).toMatchObject({
        code: 0,
        result: { number: 42, draft: true, reused: loss !== "no loss" },
      });
    }
    expect(fixture.refs()).toBe(head);

    const saved = readFileSync(fixture.receipt, "utf8");
    expect(JSON.parse(saved).submitted).toMatchObject({
      title: "Fix example.",
      body: expect.stringContaining("Fixture test — passed"),
      base: "main",
      draft: true,
    });
    vi.stubEnv("VANA_TEST_LOSE_RESPONSE", "");
    vi.stubEnv("VANA_TEST_FORK_READ_ONLY", "1");
    expect(fixture.writeAttempts()).toBe("push\ncreate PR\n");
    const recovered = await preview(
      head,
      "submit-pr",
      "--confirm",
      reviewed.result.confirmation,
    );
    expect(recovered).toMatchObject({
      code: 0,
      result: {
        number: 42,
        url: "https://github.com/PDP-Connect/data-connectors/pull/42",
        reused: true,
      },
    });
    expect(fixture.writeAttempts()).toBe("push\ncreate PR\n");
    expect(readFileSync(fixture.receipt, "utf8")).toBe(saved);
    expect(fixture.refs()).toBe(head);
  },
);

it("refuses to publish a commit range whose intermediate contents were absent from the preview", async () => {
  const privateFile = path.join(checkout, "private.txt");
  writeFileSync(privateFile, "private example data");
  commit();
  rmSync(privateFile);
  head = commit();
  const reviewed = await preview(head, "submit-pr");
  expect(reviewed).toMatchObject({
    code: 1,
    result: { error: { code: "single_connector_update_required" } },
  });
});
