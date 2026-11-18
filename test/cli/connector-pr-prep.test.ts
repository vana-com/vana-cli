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

function writeConnector(
  version: string,
  otherVersion = "1.0.0",
  metadata: {
    stream?: Record<string, unknown>;
    credentialEnv?: string;
    reasonMessages?: Record<string, string>;
  } = {},
) {
  const manifest = {
    connector_key: "example",
    version,
    capabilities: { public_listing: { tier: "development" } },
    reason_display_messages: metadata.reasonMessages,
    streams: [{ name: "items", required: true, ...metadata.stream }],
    setup: {
      credential_capture: {
        kind: "personal_access_token",
        fields: [
          { secret: true, env: [metadata.credentialEnv ?? "SYNTHETIC_TOKEN"] },
        ],
      },
    },
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

function reviewEvidence(commit: string) {
  return {
    kind: "synthetic",
    commit,
    omissions:
      "Synthetic fixture covers items only; no other provider data is claimed.",
    conformance: {
      schema: "pdpp.conformance-report/1",
      base_revision: base,
      connector: "example",
      tier: "development",
      mode: "full",
      isKnownScaffold: false,
      subject: {
        revision: commit,
        clean: true,
        source_digest: "a".repeat(64),
        declaration_digest: "b".repeat(64),
      },
      steps: [
        "manifest",
        "tests",
        "pilot fixture",
        "evidence",
        "coverage",
        "shared helpers",
        "semantics",
        "mock mutation",
      ].map((name) => ({
        name,
        verdict: name === "evidence" ? "UNKNOWN" : "PASS",
        detail:
          name === "evidence"
            ? "No author replay claim"
            : "Passed synthetic fixture check",
        required_for_review: ["manifest", "tests", "coverage"].includes(name),
      })),
    },
    dispositions: {
      evidence:
        "Development tier; this synthetic fixture has no author-account claim.",
    },
    checkedAt: "2026-11-11T00:00:00Z",
    environment: "Node 24.22.1, synthetic fixture",
    checks: [
      {
        name: "Fixture test",
        result: "passed",
        command: "node --test connectors/example/index.test.cjs",
        exitCode: 0,
        output: "tests 1\npass 1\nfail 0",
      },
    ],
    sample: {
      source: { id: "item-1", text: "Demo\\, review" },
      before: { id: "item-1", text: "Demo\\, review" },
      after: { id: "item-1", text: "Demo, review" },
    },
    storedData:
      "IDs and types stay the same. Existing records require reimport; the cursor skips past records.",
  };
}

async function preview(
  evidenceCommit: string | Record<string, unknown>,
  command = "prepare-pr",
  ...args: string[]
) {
  const evidence = path.join(root, "synthetic.json");
  writeFileSync(
    evidence,
    JSON.stringify(
      typeof evidenceCommit === "string"
        ? reviewEvidence(evidenceCommit)
        : evidenceCommit,
    ),
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

it("blocks a complete synthetic envelope with no upstream report before GitHub writes", async () => {
  const { writes } = githubFixture();
  const evidence: Record<string, unknown> = reviewEvidence(head);
  delete evidence.conformance;
  const { code, result } = await preview(evidence, "submit-pr");
  expect(code).toBe(1);
  expect(result.error.code).toBe("submission_not_ready");
  expect(existsSync(writes)).toBe(false);
});

it("keeps an explained Development evidence gap visible without blocking review", async () => {
  const { code, result } = await preview(head);
  expect(code).toBe(0);
  expect(result.readiness).toMatchObject({
    ready: true,
    tier: "development",
    accountEvidence: { status: "none" },
  });
  expect(result.prBody).toContain("evidence: UNKNOWN");
  expect(result.prBody).toContain(
    "Development tier; this synthetic fixture has no author-account claim.",
  );
});

it.each([
  "revision",
  "base",
  "dirty",
  "mode",
  "tier",
  "connector",
  "required",
  "unexplained",
])("withholds review readiness for %s report drift", async (change) => {
  const evidence = reviewEvidence(head);
  if (change === "revision") evidence.conformance.subject.revision = base;
  // A fork main can contain the proposed connector; its legacy policy is not upstream policy.
  if (change === "base") evidence.conformance.base_revision = head;
  if (change === "dirty") evidence.conformance.subject.clean = false;
  if (change === "mode") evidence.conformance.mode = "static";
  if (change === "tier") evidence.conformance.tier = "preview";
  if (change === "connector") evidence.conformance.connector = "other";
  if (change === "required") {
    evidence.conformance.steps.find(
      (step) => step.name === "coverage",
    )!.verdict = "UNKNOWN";
    Object.assign(evidence.dispositions, {
      coverage: "Would prefer to add the driver later.",
    });
  }
  if (change === "unexplained")
    delete (evidence.dispositions as Record<string, string>).evidence;
  const { code, result } = await preview(evidence);
  expect(code).toBe(0);
  expect(result.readiness.ready).toBe(false);
  expect(result.readiness.gaps.length).toBeGreaterThan(0);
  if (change === "base")
    expect(result.readiness.gaps).toContain(
      "Run conformance with CONFORMANCE_BASE_REF set to the submission base commit.",
    );
});

it.each([false, true])(
  "reports captured claim binding accurately when captured digests are stale: %s",
  async (stale) => {
    const claim = {
      schema: "pdpp.connector-claim/1",
      connector: "example",
      claim: "diagnostic_replay",
      captured_at: "2026-11-18T00:00:00Z",
      verified_at: "2026-11-18T00:01:00Z",
      captured_with: {
        source_digest: (stale ? "c" : "a").repeat(64),
        declaration_digest: "b".repeat(64),
      },
      verified_subject: {
        source_digest: "a".repeat(64),
        declaration_digest: "b".repeat(64),
      },
      runs: 2,
      coverage: [
        "empty_state_run",
        "state_seeded_second_run_with_changed_requests",
      ],
      drivers: ["recorded-http"],
      limitations: ["process-local network isolation"],
      scenario_path: "private-account-scenario.json",
    };
    mkdirSync(path.join(checkout, "connectors/example/evidence"));
    writeFileSync(
      path.join(checkout, "connectors/example/evidence/claim.json"),
      JSON.stringify(claim),
    );
    head = commit();
    const evidence = reviewEvidence(head);
    evidence.conformance.steps.find(
      (step) => step.name === "evidence",
    )!.verdict = "PASS";
    delete (evidence.dispositions as Record<string, string>).evidence;
    const { code, result } = await preview(evidence);
    expect(code).toBe(0);
    expect(result.readiness.accountEvidence.status).toBe(
      stale ? "stale" : "bound",
    );
    expect(result.readiness.ready).toBe(!stale);
    if (!stale) {
      expect(result.prBody).toContain(
        "Author replay claim: bound to this submitted source and manifest.",
      );
      expect(result.prBody).toContain("process-local network isolation");
    }
    expect(result.prBody).not.toContain(
      "Live provider behavior and Vana app availability remain unverified.",
    );
  },
);

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

it.each(["unreviewed", "connectors/example/unreviewed"])(
  "rejects a committed gitlink at %s even when Git hides submodule changes",
  async (gitlink) => {
    git("update-index", "--add", "--cacheinfo", "160000", base, gitlink);
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
      "--no-gpg-sign",
    );
    head = git("rev-parse", "HEAD").trim();
    git("config", "diff.ignoreSubmodules", "all");

    const { code, result } = await preview(head);

    expect(code).toBe(1);
    expect(result.error.code).toBe(
      gitlink.startsWith("connectors/")
        ? "non_regular_file"
        : "connector_diff_required",
    );
    expect(result).not.toHaveProperty("diff");
  },
);

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
    result: { error: { code: "single_connector_commit_required" } },
  });
});

const rosterFile =
  "packages/polyfill-connectors/src/connector-conformance-roster.ts";
const awaitListFile =
  "packages/polyfill-connectors/scripts/no-await-in-loops-allowlist.ts";
const generatedRoot = "packages/polyfill-connectors/src/generated/";
const consentAggregate = generatedRoot + "consent-time-fields.generated.ts";
const consentSlice = generatedRoot + "consent-time-fields/example.generated.ts";
const staticSecret = generatedRoot + "static-secret-registry.generated.ts";
const manifestCount =
  "packages/polyfill-connectors/src/public-listing-manifest-honesty.test.ts";
const consentHeader =
  "export const CONSENT_TIME_FIELDS: Readonly<\n\tRecord<string, Readonly<Record<string, ConsentTimeField | null>>>\n> = {\n";
const consentRow = "\texample: {\n\t\titems: null,\n\t},\n";
const publishFile = "scripts/connector-publish-allowlist.mjs";
const publishHeader =
  "export const CONNECTOR_PUBLISH_INVENTORY = Object.freeze(\n  [\n";
const coverageFile = "connectors/_conformance/coverage-conformance-drivers.ts";
const driverHeader =
  "export const CONNECTOR_DRIVERS: Record<string, ConnectorDriver> = {\n";
const coverageHeader =
  "export const KNOWN_UNEXERCISED_COVERAGE: ReadonlySet<string> = new Set([\n";
const selectedCoverageGap =
  '\t// Development collector fixture. Shared driver is pending.\n\t"example.items",\n';
const rosterHeader =
  "export const REAL_UNLISTED_CONNECTORS: Record<string, { testFile: string }> = {\n";
const awaitListHeader =
  "export const NO_AWAIT_IN_LOOPS_ALLOWLIST: readonly NoAwaitInLoopsAllowlistEntry[] =\n\t[\n";
const newRosterRow =
  '\texample: { testFile: "connectors/example/index.test.cjs" },\n';
const awaitRow = (connector: string) =>
  [
    "\t\t{",
    '\t\t\tpath: "connectors/' + connector + '/index.ts",',
    "\t\t\tline: 2,",
    "\t\t\tcolumn: 3,",
    '\t\t\tcategory: "dependent_pagination",',
    '\t\t\tnote: "Read the next page after the cursor arrives.",',
    "\t\t},",
    "",
  ].join("\n");

function writeRegistrationFixture(added: boolean) {
  const roster = path.join(checkout, rosterFile);
  const awaitList = path.join(checkout, awaitListFile);
  mkdirSync(path.dirname(roster), { recursive: true });
  mkdirSync(path.dirname(awaitList), { recursive: true });
  writeFileSync(
    roster,
    rosterHeader +
      (added ? newRosterRow : "") +
      '\tother: { testFile: "connectors/other/index.test.ts" },\n};\n',
  );
  writeFileSync(
    awaitList,
    awaitListHeader +
      (added ? awaitRow("example") : "") +
      awaitRow("other") +
      "\t];\n",
  );
  const coverage = path.join(checkout, coverageFile);
  mkdirSync(path.dirname(coverage), { recursive: true });
  writeFileSync(
    coverage,
    driverHeader +
      '\tother: { coveredStreams: ["items"], run: driveOther },\n};\n' +
      coverageHeader +
      (added ? selectedCoverageGap : "") +
      '\t"other.items",\n]);\n',
  );
  const publish = path.join(checkout, publishFile);
  mkdirSync(path.dirname(publish), { recursive: true });
  writeFileSync(
    publish,
    publishHeader +
      (added ? '    ["example", "example"],\n' : "") +
      '    ["other", "other"],\n  ],\n);\n',
  );
  const consent = path.join(checkout, consentAggregate);
  const secret = path.join(checkout, staticSecret);
  mkdirSync(path.dirname(consent), { recursive: true });
  const otherConsent = "\tother: {\n\t\titems: null,\n\t},\n";
  writeFileSync(
    consent,
    consentHeader + otherConsent + (added ? consentRow : "") + "};\n",
  );
  const secretHeader =
    "export const GENERATED_STATIC_SECRET_REGISTRY: Readonly<\n\tRecord<string, GeneratedStaticSecretDescriptor>\n> = Object.freeze({\n";
  const secretRow =
    '\texample: {\n\t\tcredentialKind: "personal_access_token",\n\t\tsecretEnvVars: ["SYNTHETIC_TOKEN"],\n\t},\n';
  writeFileSync(secret, secretHeader + (added ? secretRow : "") + "});\n");
  const count = path.join(checkout, manifestCount);
  writeFileSync(
    count,
    "test('manifest inventory', () => {\n\tassert.equal(names.length, " +
      (added ? 2 : 1) +
      ");\n});\n",
  );
  if (added) {
    const slice = path.join(checkout, consentSlice);
    mkdirSync(path.dirname(slice), { recursive: true });
    writeFileSync(
      slice,
      '// Generated for example.\n\nimport type { ConsentTimeField } from "../../time-range.ts";\n\nexport const CONSENT_BOUND_CONNECTOR: string | null = "example";\n\n' +
        consentHeader +
        consentRow +
        "};\n",
    );
  }
}

function makeNewConnector(baseHasKey = false, registerDriver = false) {
  git("checkout", "--quiet", "--detach", base);
  rmSync(path.join(checkout, "connectors/example"), { recursive: true });
  const indexPath = path.join(checkout, "connector-implementation-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!baseHasKey) {
    index.connectors = index.connectors.filter(
      (entry: { manifest: { connector_key: string } }) =>
        entry.manifest.connector_key !== "example",
    );
  }
  writeFileSync(indexPath, JSON.stringify(index));
  writeRegistrationFixture(false);
  base = commit();
  mkdirSync(path.join(checkout, "connectors/example"));
  writeConnector("0.1.0");
  writeFileSync(
    path.join(checkout, "connectors/example/index.ts"),
    String.raw`import { readFileSync } from "node:fs";
const item = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({ id: item.id, text: item.text.replaceAll("\\,", ",") }));
`,
  );
  const source = { id: "item-1", text: "Demo\\, review" };
  writeFileSync(
    path.join(checkout, "connectors/example/source.json"),
    JSON.stringify(source),
  );
  writeFileSync(
    path.join(checkout, "connectors/example/index.test.cjs"),
    String.raw`const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
test("emits the synthetic record with its stable ID and decoded text", () => {
  const input = readFileSync(join(__dirname, "source.json"), "utf8");
  const output = execFileSync(process.execPath, ["--experimental-strip-types", join(__dirname, "index.ts")], { input, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { id: "item-1", text: "Demo, review" });
});
`,
  );
  writeRegistrationFixture(true);
  if (registerDriver) registerExampleDriver();
  head = commit();
}

function registerExampleDriver() {
  writeFileSync(
    path.join(checkout, "connectors/example/coverage-driver.ts"),
    "export async function runCoverageDriver() { return { exercised: true, messages: [] }; }\n",
  );
  const file = path.join(checkout, coverageFile);
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(
        driverHeader,
        driverHeader +
          '\texample: {\n\t\tcoveredStreams: ["items"],\n\t\trun: async () =>\n\t\t\t(await import("../example/coverage-driver.ts")).runCoverageDriver(),\n\t},\n',
      )
      .replace(selectedCoverageGap, ""),
  );
}

it("previews adding coverage for an existing connector and removing its exemption", async () => {
  git("checkout", "--quiet", "--detach", base);
  writeRegistrationFixture(true);
  base = commit();
  writeConnector("1.0.1");
  registerExampleDriver();
  head = commit();

  const { code, result } = await preview(head);
  expect(code).toBe(0);
  expect(result.diff).toContain(
    'await import("../example/coverage-driver.ts")',
  );
  expect(result.diff).toContain('-\t"example.items",');
});

it("previews regenerated metadata for an existing connector", async () => {
  git("checkout", "--quiet", "--detach", base);
  writeRegistrationFixture(true);
  const libraryMetadata =
    "packages/polyfill-connectors/src/manifest-library-metadata.json";
  writeFileSync(path.join(checkout, libraryMetadata), "[]\n");
  base = commit();
  const reasonMessages = { example_auth_failed: "Reconnect your account." };
  writeConnector("1.0.1", "1.0.0", {
    credentialEnv: "EXAMPLE_TOKEN",
    reasonMessages,
    stream: {
      consent_time_field: "created_at",
      schema: {
        properties: { created_at: { type: "string", format: "date-time" } },
      },
    },
  });
  writeFileSync(
    path.join(checkout, libraryMetadata),
    JSON.stringify([
      {
        file: "example.json",
        manifest: {
          connector_key: "example",
          reason_display_messages: reasonMessages,
        },
      },
    ]),
  );
  const timeRow = consentRow.replace(
    "null",
    '{ field: "created_at", format: "date-time" }',
  );
  const changes = [
    [staticSecret, "SYNTHETIC_TOKEN", "EXAMPLE_TOKEN"],
    [consentAggregate, consentRow, timeRow],
    [consentSlice, consentRow, timeRow],
  ];
  for (const [name, before, after] of changes) {
    const file = path.join(checkout, name);
    writeFileSync(file, readFileSync(file, "utf8").replace(before, after));
  }
  head = commit();

  const { code, result } = await preview(head);
  expect(code).toBe(0);
  expect(result.files).toEqual(
    expect.arrayContaining([
      staticSecret,
      consentAggregate,
      consentSlice,
      libraryMetadata,
    ]),
  );
});

it.each([
  ["../example/coverage-driver.ts", "../other/coverage-driver.ts"],
  ['coveredStreams: ["items"]', 'coveredStreams: ["other_items"]'],
  ["run: driveOther", "run: driveExample"],
])("rejects a coverage change that alters %s", async (before, after) => {
  makeNewConnector(false, true);
  const file = path.join(checkout, coverageFile);
  writeFileSync(file, readFileSync(file, "utf8").replace(before, after));
  head = commit();

  const { code, result } = await preview(head);
  expect(code).toBe(1);
  expect(result.error.code).toBe("invalid_connector_registration");
});

function captureNewConnectorEvidence() {
  const source = JSON.parse(
    readFileSync(path.join(checkout, "connectors/example/source.json"), "utf8"),
  );
  const output = execFileSync(
    process.execPath,
    ["--test", "connectors/example/index.test.cjs"],
    {
      cwd: checkout,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const record = JSON.parse(
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "connectors/example/index.ts"],
      {
        cwd: checkout,
        input: JSON.stringify(source),
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  );
  const evidence = path.join(root, "new-connector-evidence.json");
  writeFileSync(
    evidence,
    JSON.stringify({
      ...reviewEvidence(head),
      environment: "Node " + process.version + ", synthetic fixture",
      checks: [
        {
          name: "Synthetic record test",
          result: "passed",
          command: "node --test connectors/example/index.test.cjs",
          exitCode: 0,
          output,
        },
      ],
      sample: { source, after: record },
      storedData:
        "Initial upstream connector. Existing local test records are unchanged. IDs use the source item ID.",
    }),
  );
  return evidence;
}

withShellFixtures(
  "submits a new connector with review evidence and recovers it without writes",
  async () => {
    makeNewConnector(false, true);
    const evidence = captureNewConnectorEvidence();
    const fixture = githubFixture();
    const reviewed = await preview(head, "submit-pr", "--evidence", evidence);
    expect(reviewed.code).toBe(7);
    expect(reviewed.result).toMatchObject({
      kind: "confirmation_required",
      change: "new",
      previousVersion: null,
      version: "0.1.0",
    });
    expect(reviewed.result.prBody).toContain("New connector");
    expect(reviewed.result.files).toEqual(
      expect.arrayContaining([
        rosterFile,
        awaitListFile,
        coverageFile,
        publishFile,
      ]),
    );
    expect(reviewed.result.prBody).toContain(
      "node --test connectors/example/index.test.cjs",
    );
    expect(reviewed.result.prBody).toContain("Exit status: 0");
    expect(reviewed.result.prBody).toContain("Demo, review");
    expect(fixture.refs()).toBe("");
    const confirmed = await preview(
      head,
      "submit-pr",
      "--evidence",
      evidence,
      "--confirm",
      reviewed.result.confirmation,
    );
    expect(confirmed).toMatchObject({
      code: 0,
      result: { number: 42, draft: true, reused: false },
    });
    const submitted = JSON.parse(
      readFileSync(fixture.receipt, "utf8"),
    ).submitted;
    expect(submitted.body).toContain(head);
    expect(submitted.body).toContain("tests 1");
    expect(submitted.body).toContain("Demo, review");
    vi.stubEnv("VANA_TEST_FORK_READ_ONLY", "1");
    expect(
      await preview(
        head,
        "submit-pr",
        "--evidence",
        evidence,
        "--confirm",
        reviewed.result.confirmation,
      ),
    ).toMatchObject({
      code: 0,
      result: { number: 42, reused: true },
    });
    expect(fixture.writeAttempts()).toBe("push\ncreate PR\n");
    expect(fixture.refs()).toBe(head);
  },
  15_000,
);

withShellFixtures.each([
  [
    "missing environment",
    { environment: undefined },
    "review_evidence_required",
  ],
  ["missing sample", { sample: undefined }, "review_evidence_required"],
  [
    "missing stored-data effect",
    { storedData: undefined },
    "review_evidence_required",
  ],
  [
    "missing command and output",
    { checks: [{ name: "Fixture test", result: "passed" }] },
    "review_evidence_required",
  ],
  [
    "missing previous output",
    { sample: { source: {}, after: {} } },
    "review_evidence_required",
  ],
  [
    "contradictory exit status",
    {
      checks: [
        {
          name: "Fixture test",
          result: "passed",
          command: "node --test",
          exitCode: 1,
          output: "failed",
        },
      ],
    },
    "invalid_evidence",
  ],
])("blocks submission with %s before any write", async (_name, patch, code) => {
  const fixture = githubFixture();
  const evidence = path.join(root, "incomplete.json");
  writeFileSync(
    evidence,
    JSON.stringify({ ...reviewEvidence(head), ...(patch as object) }),
  );
  expect(
    await preview(head, "submit-pr", "--evidence", evidence),
  ).toMatchObject({
    code: 1,
    result: { error: { code } },
  });
  expect(fixture.refs()).toBe("");
  expect(existsSync(fixture.receipt)).toBe(false);
});

it("keeps legacy evidence previewable and makes its review gaps explicit", async () => {
  const evidence = path.join(root, "legacy.json");
  writeFileSync(
    evidence,
    JSON.stringify({
      kind: "synthetic",
      commit: head,
      checkedAt: "2026-11-11T00:00:00Z",
      checks: [{ name: "Old summary", result: "passed" }],
    }),
  );
  const { code, result } = await preview(
    head,
    "prepare-pr",
    "--evidence",
    evidence,
  );
  expect(code).toBe(0);
  expect(result.prBody).toContain("Old summary");
  expect(result.reviewGaps).toContain(
    "Missing a reviewed synthetic source item and output record.",
  );
});

withShellFixtures(
  "requires fresh confirmation if evidence changes after review",
  async () => {
    const fixture = githubFixture();
    const reviewed = await preview(head, "submit-pr");
    const evidence = path.join(root, "edited.json");
    writeFileSync(
      evidence,
      JSON.stringify({
        ...reviewEvidence(head),
        storedData: "Updated migration explanation after review.",
      }),
    );
    expect(
      await preview(
        head,
        "submit-pr",
        "--evidence",
        evidence,
        "--confirm",
        reviewed.result.confirmation,
      ),
    ).toMatchObject({
      code: 7,
      result: { error: { code: "confirmation_mismatch" } },
    });
    expect(fixture.refs()).toBe("");
    expect(existsSync(fixture.receipt)).toBe(false);
  },
);

it("rejects a new connector whose key is already declared upstream", async () => {
  makeNewConnector(true);
  const { code, result } = await preview(head);
  expect(code).toBe(1);
  expect(result.error.code).toBe("connector_key_conflict");
});

it("rejects a connector with no committed entry point", async () => {
  rmSync(path.join(checkout, "connectors/example/index.ts"));
  head = commit();
  const { code, result } = await preview(head);
  expect(code).toBe(1);
  expect(result.error.code).toBe("connector_entry_missing");
});

it("keeps failed and skipped checks visible and safely quotes review output", async () => {
  const evidence = path.join(root, "reported-results.json");
  const passed = reviewEvidence(head).checks[0];
  writeFileSync(
    evidence,
    JSON.stringify({
      ...reviewEvidence(head),
      checks: [
        passed,
        {
          ...passed,
          name: "Known upstream failure",
          result: "failed",
          exitCode: 1,
          output: "````\nfailed on the documented baseline\n````",
        },
        {
          ...passed,
          name: "Live provider",
          result: "not run",
          exitCode: null,
          output: "No live provider access was used.",
        },
      ],
    }),
  );
  const { code, result } = await preview(
    head,
    "prepare-pr",
    "--evidence",
    evidence,
  );
  expect(code).toBe(0);
  expect(result.prBody).toContain("Fixture test — passed");
  expect(result.prBody).toContain("Known upstream failure — failed");
  expect(result.prBody).toContain("Live provider — not run");
  expect(result.prBody).toContain("Exit status: not run");
  expect(result.prBody).toContain(
    "`````text\n````\nfailed on the documented baseline\n````\n`````",
  );
  expect(result.readiness.accountEvidence.status).toBe("none");
  expect(result.prBody).not.toContain("Vana app availability");
});

it("rejects evidence that cannot fit into the public PR description", async () => {
  const evidence = path.join(root, "oversized.json");
  writeFileSync(
    evidence,
    JSON.stringify({
      ...reviewEvidence(head),
      sample: { source: {}, before: {}, after: { text: "x".repeat(60_000) } },
    }),
  );
  expect(
    await preview(head, "prepare-pr", "--evidence", evidence),
  ).toMatchObject({
    code: 1,
    result: { error: { code: "review_evidence_too_large" } },
  });
});

it.each([
  [
    "a generated credential not declared by the connector",
    staticSecret,
    '["SYNTHETIC_TOKEN"]',
    '["OTHER_TOKEN"]',
  ],
  [
    "an unrelated stream in the generated consent row",
    consentAggregate,
    "items: null",
    "unexpected: null",
  ],
  [
    "executable code in the consent slice",
    consentSlice,
    "// Generated for example.",
    "console.log(process.env);",
  ],
  [
    "an incorrect manifest count increment",
    manifestCount,
    "names.length, 2",
    "names.length, 3",
  ],
  [
    "a mismatched publication identity",
    publishFile,
    '["example", "example"]',
    '["example", "other"]',
  ],
  [
    "a different connector's coverage entry",
    coverageFile,
    '"example.items"',
    '"other.items"',
  ],
  [
    "an undeclared coverage stream",
    coverageFile,
    '"example.items"',
    '"example.missing"',
  ],
  [
    "another roster entry",
    rosterFile,
    'other: { testFile: "connectors/other/index.test.ts" }',
    'other: { testFile: "connectors/other/replaced.test.ts" }',
  ],
  [
    "a roster target outside the connector",
    rosterFile,
    "connectors/example/index.test.cjs",
    "connectors/other/index.test.ts",
  ],
  [
    "an uncommitted roster test",
    rosterFile,
    "connectors/example/index.test.cjs",
    "connectors/example/missing.test.ts",
  ],
  ["another allowlist entry", awaitListFile, awaitRow("other"), ""],
  [
    "an allowlist path outside the connector",
    awaitListFile,
    "connectors/example/index.ts",
    "connectors/example/../other/index.ts",
  ],
  [
    "a registration with additional code",
    awaitListFile,
    "line: 2,",
    "line: readProcessEnv(),",
  ],
])(
  "rejects %s in a new-connector registration",
  async (_name, file, before, after) => {
    makeNewConnector();
    const target = path.join(checkout, file);
    const text = readFileSync(target, "utf8");
    expect(text).toContain(before);
    writeFileSync(target, text.replace(before, after));
    head = commit();
    const { code, result } = await preview(head);
    expect(code).toBe(1);
    expect(result.error.code).toBe("invalid_connector_registration");
    expect(result).not.toHaveProperty("diff");
  },
);
