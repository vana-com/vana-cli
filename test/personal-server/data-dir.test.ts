import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  legacyServerOwner,
  listServerDataDirs,
  resolveServerDataDir,
  runningCliServers,
  serverToStop,
  type CliServerDir,
} from "../../src/personal-server/local/data-dir.js";

const A = "0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d";
const B = "0xAff7000000000000000000000000000000000001";
const KEY = "0x86F0c856718414eE5A52AB23f3bA1fd150563BB3";
const DEAD_PID = 4_194_303;

let home: string;
const network = () => path.join(home, "cli", "personal-server", "mainnet");
const accountDir = (owner: string) => path.join(network(), owner.toLowerCase());

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A server an older vana ran straight from the network dir. */
function legacyServer(options: { lockPid?: number } = {}) {
  const dir = network();
  write(
    path.join(dir, "key.json"),
    JSON.stringify({ address: KEY, privateKey: "0xsecret" }),
  );
  write(path.join(dir, "index.db"), "index");
  write(path.join(dir, "data", "chatgpt", "1.json"), "{}");
  write(
    path.join(dir, ".vana-cli-public.json"),
    JSON.stringify({ serverAddress: KEY, serverUrl: "https://x" }),
  );
  write(path.join(dir, "detached.log"), "");
  if (options.lockPid) {
    write(
      path.join(dir, ".vana-cli.lock"),
      JSON.stringify({ pid: options.lockPid }),
    );
  }
}

function tunnelConfig(owner: string, wallet = KEY) {
  write(
    path.join(network(), "tunnel", "frpc.toml"),
    `serverAddr = "frpc.server.vana.org"\nmetadatas.wallet = "${wallet}"\nmetadatas.owner = "${owner}"\n`,
  );
}

function startLog(owner: string, serverAddress = KEY) {
  write(
    path.join(home, "logs", "server-start-2026-10-01T12-00-00-000Z.log"),
    [
      "[status] starting",
      JSON.stringify({ level: 30, owner, msg: "Server owner derived" }),
      JSON.stringify({
        level: 30,
        owner,
        serverAddress,
        msg: "Server account loaded",
      }),
    ].join("\n"),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-ps-dirs-"));
  process.env.VANA_HOME = home;
});
afterEach(() => {
  delete process.env.VANA_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("resolveServerDataDir", () => {
  it("gives each account its own dir, and records whose it is", async () => {
    expect(await resolveServerDataDir("mainnet", A)).toEqual({
      kind: "ready",
      dir: accountDir(A),
    });
    expect(await resolveServerDataDir("mainnet", B)).toEqual({
      kind: "ready",
      dir: accountDir(B),
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(accountDir(B), ".vana-cli-owner.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ owner: B, network: "mainnet" });
  });

  it("moves an older server into its owner's dir with nothing lost", async () => {
    legacyServer({ lockPid: DEAD_PID });
    tunnelConfig(A);
    expect(await resolveServerDataDir("mainnet", A)).toEqual({
      kind: "ready",
      dir: accountDir(A),
      movedFrom: network(),
    });
    const dir = accountDir(A);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "key.json"), "utf8")),
    ).toMatchObject({ address: KEY });
    expect(fs.readFileSync(path.join(dir, "index.db"), "utf8")).toBe("index");
    expect(fs.existsSync(path.join(dir, "data", "chatgpt", "1.json"))).toBe(
      true,
    );
    // Still registered: the next start brings its tunnel back.
    expect(fs.existsSync(path.join(dir, ".vana-cli-public.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".vana-cli.lock"))).toBe(false);
    expect(fs.existsSync(path.join(network(), "key.json"))).toBe(false);
    expect(fs.readdirSync(network())).toEqual([A.toLowerCase()]);

    // The next start finds it where it is now.
    expect(await resolveServerDataDir("mainnet", A)).toEqual({
      kind: "ready",
      dir,
    });
  });

  it("moves another account's older server to that account, never to the one starting", async () => {
    legacyServer();
    startLog(A);
    expect(await resolveServerDataDir("mainnet", B)).toEqual({
      kind: "ready",
      dir: accountDir(B),
    });
    expect(fs.existsSync(path.join(accountDir(B), "key.json"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(accountDir(A), "key.json"), "utf8")),
    ).toMatchObject({ address: KEY });

    expect(await resolveServerDataDir("mainnet", A)).toEqual({
      kind: "ready",
      dir: accountDir(A),
    });
  });

  it("leaves a running older server where it is and starts the other account beside it", async () => {
    legacyServer({ lockPid: process.pid });
    tunnelConfig(A);
    expect(await resolveServerDataDir("mainnet", B)).toEqual({
      kind: "ready",
      dir: accountDir(B),
    });
    expect(fs.existsSync(path.join(network(), "key.json"))).toBe(true);
    // Its owner gets it back as it is, running.
    expect(await resolveServerDataDir("mainnet", A)).toEqual({
      kind: "ready",
      dir: network(),
    });
    expect(fs.existsSync(path.join(network(), "key.json"))).toBe(true);
  });

  it("knows a running older server's owner from its health", async () => {
    legacyServer({ lockPid: process.pid });
    expect(
      legacyServerOwner("mainnet", [
        { url: "http://localhost:8080", owner: A, identity: KEY.toLowerCase() },
      ]),
    ).toBe(A);
    expect(legacyServerOwner("mainnet")).toBeNull();
  });

  it("does not trust a tunnel config written for another server key", async () => {
    legacyServer();
    tunnelConfig(A, "0x0000000000000000000000000000000000000001");
    expect(legacyServerOwner("mainnet")).toBeNull();
  });

  it("refuses to guess the owner of an older server and moves nothing", async () => {
    legacyServer();
    startLog(A, "0x0000000000000000000000000000000000000001");
    expect(await resolveServerDataDir("mainnet", B)).toEqual({
      kind: "unknown-owner",
      legacyDir: network(),
      dir: accountDir(B),
    });
    expect(fs.existsSync(path.join(network(), "key.json"))).toBe(true);
    expect(fs.existsSync(accountDir(B))).toBe(false);
  });

  it("finishes a move an earlier start did not complete", async () => {
    legacyServer();
    const staging = path.join(network(), `.moving-${A.toLowerCase()}`);
    fs.mkdirSync(staging);
    fs.renameSync(
      path.join(network(), "key.json"),
      path.join(staging, "key.json"),
    );
    expect(await resolveServerDataDir("mainnet", A)).toMatchObject({
      kind: "ready",
      dir: accountDir(A),
    });
    expect(fs.existsSync(path.join(accountDir(A), "key.json"))).toBe(true);
    expect(fs.existsSync(path.join(accountDir(A), "index.db"))).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("never hands one account a dir recorded as another's", async () => {
    write(
      path.join(accountDir(B), ".vana-cli-owner.json"),
      JSON.stringify({ owner: A }),
    );
    await expect(resolveServerDataDir("mainnet", B)).rejects.toThrow(
      /holds the Personal Server of/,
    );
  });
});

describe("listServerDataDirs", () => {
  it("lists the older server and every account's, with who runs", async () => {
    legacyServer({ lockPid: process.pid });
    tunnelConfig(A);
    write(
      path.join(accountDir(B), ".vana-cli.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    write(path.join(accountDir(B), "key.json"), JSON.stringify({ address: B }));
    write(path.join(network(), "..", "runtime", "1.0.0", "x"), "");

    expect(listServerDataDirs("mainnet")).toEqual([
      { dir: network(), owner: A, identity: KEY, pid: process.pid },
      {
        dir: accountDir(B),
        owner: B.toLowerCase(),
        identity: B,
        pid: process.pid,
      },
    ]);
    fs.writeFileSync(
      path.join(accountDir(B), ".vana-cli.lock"),
      JSON.stringify({ pid: DEAD_PID }),
    );
    expect(runningCliServers("mainnet").map((entry) => entry.owner)).toEqual([
      A,
    ]);
  });
});

describe("serverToStop", () => {
  const server = (owner: string | null, pid: number): CliServerDir => ({
    dir: `/ps/${owner}`,
    owner,
    identity: null,
    pid,
  });

  it("stops the signed-in account's server and names the rest", () => {
    const a = server(A, 1);
    const b = server(B.toLowerCase(), 2);
    expect(serverToStop([a, b], B)).toEqual({ target: b, others: [a] });
  });

  it("never stops another account's server", () => {
    const a = server(A, 1);
    expect(serverToStop([a], B)).toEqual({ target: null, others: [a] });
  });

  it("stops the only one when nobody is signed in or its owner is unknown", () => {
    const a = server(A, 1);
    expect(serverToStop([a], null).target).toBe(a);
    const unknown = server(null, 3);
    expect(serverToStop([unknown], B).target).toBe(unknown);
  });
});
