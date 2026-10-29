import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function workspace(cli: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vana-transcript-test-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "dist/cli"), { recursive: true });
  await fs.mkdir(path.join(root, "docs/vhs/fixtures"), { recursive: true });
  for (const name of [
    "capture-cli-transcripts.mjs",
    "prepare-vhs-fixtures.mjs",
    "transcript-isolation.mjs",
  ]) {
    await fs.copyFile(
      path.resolve("scripts", name),
      path.join(root, "scripts", name),
    );
  }
  await fs.cp(
    path.resolve("docs/vhs/fixtures/demo-data-connectors"),
    path.join(root, "docs/vhs/fixtures/demo-data-connectors"),
    { recursive: true },
  );
  const document = path.join(root, "docs/CLI-TRANSCRIPTS.md");
  await fs.copyFile(path.resolve("docs/CLI-TRANSCRIPTS.md"), document);
  await fs.writeFile(path.join(root, "dist/cli/bin.js"), cli);
  const temp = path.join(root, "tmp");
  await fs.mkdir(temp);
  return { root, document, temp };
}

function capture(root: string, temp: string) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/capture-cli-transcripts.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        VANA_HOME: path.join(root, "personal-home-must-not-be-used"),
        VANA_DATA_CONNECTORS_DIR: path.join(
          root,
          "live-connectors-must-not-be-used",
        ),
      },
    },
  );
}

describe("CLI transcript capture", () => {
  it("sets browser-free fixture isolation for every captured command and removes temporary homes", async () => {
    const { root, document, temp } = await workspace(`
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.VANA_DEMO_NO_BROWSER, '1');
assert.equal(process.env.VANA_HOME, path.join(process.env.HOME, '.vana'));
assert.equal(process.env.USERPROFILE, process.env.HOME);
assert.equal(process.env.VANA_DATA_CONNECTORS_DIR, path.join(process.cwd(), 'docs/vhs/fixtures/demo-data-connectors'));
fetch('http://localhost:8080/health').then(response => assert.equal(response.status, 503));
console.log('ISOLATED FIXTURE OUTPUT');
`);
    const result = capture(root, temp);
    expect(result.status).toBe(0);
    const output = await fs.readFile(document, "utf8");
    expect(output).toContain(
      "$ vana connect github --no-input\n\nISOLATED FIXTURE OUTPUT",
    );
    expect(output).not.toContain("AssertionError");
    expect(await fs.readdir(temp)).toEqual([]);
    await expect(
      fs.access(path.join(root, "personal-home-must-not-be-used")),
    ).rejects.toThrow();
  });

  it("aborts rather than publishing an allowed-failure command that tries to spawn a browser", async () => {
    // A harmless Node child stands in for Chrome. Without the capture guard it
    // writes a sentinel, proving the launch reached the operating system.
    const { root, document, temp } = await workspace(`
if (process.argv[2] === 'connect' && process.argv.includes('--no-input')) {
  require('node:child_process').execFileSync(process.execPath, ['-e',
    "require('node:fs').writeFileSync('browser-was-launched', 'unexpected')"]);
}
console.log('fixture');
`);
    execFileSync(
      process.execPath,
      [path.join(root, "dist/cli/bin.js"), "connect", "github", "--no-input"],
      { cwd: root },
    );
    expect(
      await fs.readFile(path.join(root, "browser-was-launched"), "utf8"),
    ).toBe("unexpected");
    await fs.rm(path.join(root, "browser-was-launched"));
    const before = await fs.readFile(document, "utf8");
    const result = capture(root, temp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VANA_TRANSCRIPT_ISOLATION: Subprocess execution",
    );
    await expect(
      fs.access(path.join(root, "browser-was-launched")),
    ).rejects.toThrow();
    expect(await fs.readFile(document, "utf8")).toBe(before);
    expect(await fs.readdir(temp)).toEqual([]);
  });

  it.each([
    "fetch('https://provider.invalid')",
    "require('node:net').connect(443, 'provider.invalid')",
    "fetch('http://localhost:8080/health', { method: 'POST' })",
  ])("refuses real provider I/O: %s", async (operation) => {
    const { root, document, temp } = await workspace(`
if (process.argv[2] === 'connect') { ${operation}; }
console.log('fixture');
`);
    const before = await fs.readFile(document, "utf8");
    const result = capture(root, temp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VANA_TRANSCRIPT_ISOLATION: Network access",
    );
    expect(await fs.readFile(document, "utf8")).toBe(before);
    expect(await fs.readdir(temp)).toEqual([]);
  });
});
