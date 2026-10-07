import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureRuntime,
  NpmMissingError,
  RuntimeInstallError,
  type RuntimeInstallDeps,
} from "../../src/personal-server/local/runtime.js";

let root: string;
let nodeDir: string;
let runtimeDir: string;
let logPath: string;
const node = () => ({ path: path.join(nodeDir, "node"), version: "24.15.0" });

function spawnError(file: string): Error {
  // What execFile rejects with when the binary cannot be started.
  return Object.assign(new Error(`spawn ${file} ENOENT`), {
    code: "ENOENT",
    path: file,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vana-runtime-npm-"));
  nodeDir = path.join(root, "node", "bin");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(path.join(nodeDir, "node"), "");
  runtimeDir = path.join(root, "runtime");
  logPath = path.join(root, "install.log");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(
  exec: RuntimeInstallDeps["exec"],
  pathDirs: string[] = [],
): Partial<RuntimeInstallDeps> {
  return {
    exec,
    env: { PATH: pathDirs.join(path.delimiter) },
    platform: "darwin",
  };
}

describe("ensureRuntime without a working npm beside Node", () => {
  it("fails with a clear message, not a spawn stack, when no npm runs", async () => {
    // The 2026-10 report: npm next to node was a dangling install, and the
    // CLI died with `spawn .../bin/npm ENOENT`.
    fs.writeFileSync(path.join(nodeDir, "npm"), "");
    const exec = vi.fn(async (file: string) => {
      throw spawnError(file);
    });
    const error = await ensureRuntime(
      node(),
      logPath,
      runtimeDir,
      deps(exec),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NpmMissingError);
    const message = (error as Error).message;
    expect(message).toContain(
      `npm is missing next to the Node at ${node().path}`,
    );
    expect(message).toContain("nvm install 24.15.0");
    expect(message).toContain("VANA_PDPP_NODE");
    expect(message).not.toContain("ENOENT");
    expect(fs.readFileSync(logPath, "utf8")).toContain("did not start");
    expect(fs.existsSync(path.join(runtimeDir, ".installed"))).toBe(false);
  });

  it("says so when there is no npm at all", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      ensureRuntime(node(), logPath, runtimeDir, deps(exec)),
    ).rejects.toBeInstanceOf(NpmMissingError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to the npm on PATH", async () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const pathNpm = path.join(elsewhere, "npm");
    fs.writeFileSync(pathNpm, "");
    const calls: Array<{ file: string; env: NodeJS.ProcessEnv }> = [];
    const exec = vi.fn(
      async (
        file: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        calls.push({ file, env: options.env });
        return { stdout: "added 1 package\n", stderr: "" };
      },
    );
    expect(
      await ensureRuntime(node(), logPath, runtimeDir, deps(exec, [elsewhere])),
    ).toBe(runtimeDir);
    expect(calls.map((call) => call.file)).toEqual([pathNpm, node().path]);
    // The PATH npm still runs under the chosen Node: it leads PATH.
    expect(calls[0].env.PATH?.split(path.delimiter)[0]).toBe(nodeDir);
    expect(fs.existsSync(path.join(runtimeDir, ".installed"))).toBe(true);
  });

  it("reports a failing npm ci with its log, not a stack", async () => {
    fs.writeFileSync(path.join(nodeDir, "npm"), "");
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("Command failed: npm ci"), {
        code: 1,
        stdout: "",
        stderr: "npm error network ETIMEDOUT\n",
      });
    });
    const error = await ensureRuntime(
      node(),
      logPath,
      runtimeDir,
      deps(exec),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect((error as Error).message).toContain(logPath);
    expect(fs.readFileSync(logPath, "utf8")).toContain("ETIMEDOUT");
  });
});
