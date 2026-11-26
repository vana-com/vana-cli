import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnectorDesktop } from "../../src/cli/connector-desktop.js";
import {
  assertDesktopHandoffContext,
  desktopHandoffScopes,
  prepareDesktopHandoff,
  readDesktopHandoff,
  readDesktopHandoffStatus,
} from "../../src/pdpp/desktop-handoff.js";

let directory: string;
let checkout: string;
let inbox: string;
let node: string;
let prepared: Awaited<ReturnType<typeof prepare>>;
const context = {
  ownerAddress: `0x${"1".repeat(40)}`,
  accountUrl: "https://account-dev.vana.org" as const,
  environment: "dev" as const,
  network: "moksha" as const,
};
const profile = {
  connector_key: "desktop-synthetic",
  source: { id: "https://registry.pdpp.dev/sources/desktop_synthetic" },
  version: "0.0.1",
  streams: [{ name: "items" }, { name: "profile" }],
};
async function prepare(streams?: string[]) {
  return prepareDesktopHandoff({
    checkout,
    source: "desktop_synthetic",
    context,
    inbox,
    node,
    streams,
  });
}
// This external builder fixture exercises transport/storage, not upstream archive compatibility.
const builder = `import * as fs from "node:fs";
import path from "node:path";
if (process.env.VANA_APP_PRIVATE_KEY || process.env.PDPP_BROWSER_ENDPOINT || process.env.EXAMPLE_API_TOKEN) throw Error("secret environment inherited");
const out=process.argv[process.argv.indexOf("--out")+1];
fs.mkdirSync(out,{recursive:true});
fs.copyFileSync("connectors/desktop_synthetic/manifest.json",path.join(out,"collection-profile.json"));
fs.copyFileSync("connectors/desktop_synthetic/index.ts",path.join(out,"code.tar.gz"));
for (const name of ["licenses.tar.gz","source-declaration.json","provenance.json","config.json","layers.json"]) fs.writeFileSync(path.join(out,name),"synthetic-fixture");
`;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "vana-handoff-test-"));
  checkout = path.join(directory, "checkout with spaces");
  inbox = path.join(directory, "inbox");
  await mkdir(path.join(checkout, "connectors", "desktop_synthetic"), {
    recursive: true,
  });
  await mkdir(path.join(checkout, "scripts"));
  await writeFile(
    path.join(checkout, "connectors", "desktop_synthetic", "manifest.json"),
    JSON.stringify(profile),
  );
  await writeFile(
    path.join(checkout, "connectors", "desktop_synthetic", "index.ts"),
    "export const synthetic = 'v1';",
  );
  await writeFile(
    path.join(checkout, "connectors", "desktop_synthetic", ".env"),
    "secret-env-sentinel",
  );
  await writeFile(
    path.join(checkout, "connectors", "desktop_synthetic", "capture.json"),
    "raw-capture-sentinel",
  );
  await writeFile(
    path.join(checkout, "scripts", "build-connector-oci-artifact.mjs"),
    builder,
  );
  // The subprocess is synthetic; the separate real upstream smoke proves actual Node 24/GNU tar packaging.
  node = path.join(directory, "fixture-node");
  await writeFile(
    node,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.22.1; else exec '${process.execPath.replace(/'/g, `'"'"'`)}' "$@"; fi\n`,
  );
  await chmod(node, 0o700);
  prepared = await prepare(["items"]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Desktop frozen handoff", () => {
  it("reuses the immutable identity, excludes credentials/captures, and makes changed code a new snapshot", async () => {
    vi.stubEnv("VANA_APP_PRIVATE_KEY", "key-sentinel");
    vi.stubEnv("PDPP_BROWSER_ENDPOINT", "private-browser-sentinel");
    vi.stubEnv("EXAMPLE_API_TOKEN", "token-sentinel");
    const first = prepared;
    const again = await prepare(["items"]);
    expect(again.handoffId).toBe(first.handoffId);
    expect(again.artifactDigest).toBe(first.artifactDigest);
    expect(await readdir(inbox)).toEqual([first.handoffId]);
    const payload = path.join(inbox, first.handoffId, "payload");
    expect((await readdir(payload)).sort()).toEqual([
      "code.tar.gz",
      "collection-profile.json",
      "config.json",
      "layers.json",
      "licenses.tar.gz",
      "provenance.json",
      "source-declaration.json",
    ]);
    const saved = await readFile(
      path.join(inbox, first.handoffId, "handoff.json"),
      "utf8",
    );
    expect(saved).not.toMatch(
      /key-sentinel|private-browser-sentinel|token-sentinel|secret-env-sentinel|raw-capture-sentinel/,
    );
    await writeFile(
      path.join(checkout, "connectors", "desktop_synthetic", "index.ts"),
      "export const synthetic = 'v2';",
    );
    const changed = await prepare(["items"]);
    expect(changed.handoffId).not.toBe(first.handoffId);
    expect(changed.artifactDigest).not.toBe(first.artifactDigest);
    expect(await readFile(path.join(payload, "code.tar.gz"), "utf8")).toBe(
      "export const synthetic = 'v1';",
    );
  });

  it("rejects changed bytes, extra files and symlink replacement before resume", async () => {
    const handoff = prepared;
    const payload = path.join(inbox, handoff.handoffId, "payload");
    const code = path.join(payload, "code.tar.gz");
    const original = await readFile(code);
    await writeFile(code, "tampered");
    await expect(
      readDesktopHandoff(inbox, handoff.handoffId),
    ).rejects.toMatchObject({ code: "handoff_invalid" });
    await writeFile(code, original);
    await writeFile(path.join(payload, ".env"), "extra");
    await expect(
      readDesktopHandoff(inbox, handoff.handoffId),
    ).rejects.toMatchObject({ code: "handoff_invalid" });
    await rm(path.join(payload, ".env"));
    const replacement = path.join(directory, "replacement");
    await writeFile(replacement, original);
    await rm(code);
    await symlink(replacement, code);
    await expect(
      readDesktopHandoff(inbox, handoff.handoffId),
    ).rejects.toMatchObject({ code: "handoff_invalid" });
  });

  it("binds status/resume to owner, Account authority, environment, network and artifact", async () => {
    const handoff = prepared;
    expect(() => assertDesktopHandoffContext(handoff, context)).not.toThrow();
    for (const changed of [
      { ownerAddress: `0x${"2".repeat(40)}` },
      { accountUrl: "https://account.vana.org" as const },
      { environment: "prod" as const },
      { network: "mainnet" as const },
    ]) {
      expect(() =>
        assertDesktopHandoffContext(handoff, { ...context, ...changed }),
      ).toThrow(/another Account/);
    }
    expect(await readDesktopHandoffStatus(inbox, handoff)).toBeNull();
    await writeFile(
      path.join(checkout, "connectors", "desktop_synthetic", "manifest.json"),
      JSON.stringify({
        ...profile,
        source: { id: "https://registry.pdpp.dev/sources/changed_checkout" },
      }),
    );
    expect(await desktopHandoffScopes(inbox, handoff)).toEqual({
      sourceId: "desktop_synthetic",
      scopes: ["desktop_synthetic.items"],
    });
    if (process.platform === "darwin") {
      vi.stubEnv("VANA_ENV", "dev");
      let output = "";
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((value) => {
          output += value;
          return true;
        });
      const open = vi.fn();
      const exit = await runConnectorDesktop(
        "resume",
        handoff.handoffId,
        { open: true },
        { json: true, noInput: true, network: "moksha" },
        {
          owner: () => ({
            address: context.ownerAddress,
            accountUrl: context.accountUrl,
          }),
          inbox: () => inbox,
          open,
        },
      );
      write.mockRestore();
      expect(exit).toBe(7);
      expect(open).not.toHaveBeenCalled();
      expect(JSON.parse(output)).toMatchObject({
        handoffId: handoff.handoffId,
        state: "pending",
        connectorId: "desktop-synthetic",
        sourceId: "desktop_synthetic",
        scopes: ["desktop_synthetic.items"],
        artifactDigest: handoff.artifactDigest,
        opened: false,
        openUrl: `vana-dev://development-connector?id=${handoff.handoffId}`,
      });
    }
    const statusFile = path.join(inbox, handoff.handoffId, "status.json");
    const status = {
      schemaVersion: 1,
      handoffId: handoff.handoffId,
      connectorId: handoff.connectorId,
      artifactDigest: handoff.artifactDigest,
      state: "enabled",
      code: "enabled",
    };
    await writeFile(statusFile, JSON.stringify(status));
    expect(await readDesktopHandoffStatus(inbox, handoff)).toEqual(status);
    await writeFile(
      statusFile,
      JSON.stringify({ ...status, artifactDigest: `sha256:${"0".repeat(64)}` }),
    );
    await expect(
      readDesktopHandoffStatus(inbox, handoff),
    ).rejects.toMatchObject({ code: "desktop_status_invalid" });
  });

  it.skipIf(process.platform !== "darwin")(
    "explicitly reopens an enabled snapshot for management while automated modes stay closed",
    async () => {
      vi.stubEnv("VANA_ENV", "dev");
      const status = {
        schemaVersion: 1,
        handoffId: prepared.handoffId,
        connectorId: prepared.connectorId,
        artifactDigest: prepared.artifactDigest,
        state: "enabled",
        code: "enabled",
      };
      await writeFile(
        path.join(inbox, prepared.handoffId, "status.json"),
        JSON.stringify(status),
      );
      const previousTTY = Object.getOwnPropertyDescriptor(
        process.stdout,
        "isTTY",
      );
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      const output = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const open = vi.fn();
      const deps = {
        owner: () => ({
          address: context.ownerAddress,
          accountUrl: context.accountUrl,
        }),
        inbox: () => inbox,
        open,
      };
      try {
        expect(
          await runConnectorDesktop(
            "resume",
            prepared.handoffId,
            { open: true },
            { network: "moksha" },
            deps,
          ),
        ).toBe(0);
        expect(open).toHaveBeenCalledExactlyOnceWith(
          `vana-dev://development-connector?id=${prepared.handoffId}`,
        );
        await runConnectorDesktop(
          "resume",
          prepared.handoffId,
          { open: true },
          { network: "moksha", noInput: true },
          deps,
        );
        await runConnectorDesktop(
          "resume",
          prepared.handoffId,
          { open: true },
          { network: "moksha", json: true },
          deps,
        );
        expect(open).toHaveBeenCalledTimes(1);
        expect(await readDesktopHandoffStatus(inbox, prepared)).toEqual(status);
      } finally {
        output.mockRestore();
        if (previousTTY)
          Object.defineProperty(process.stdout, "isTTY", previousTTY);
        else delete process.stdout.isTTY;
      }
    },
  );

  it("refuses scope-incompatible source/stream names and public source collisions before packaging", async () => {
    inbox = path.join(directory, "scope-incompatible-inbox");
    const manifest = path.join(
      checkout,
      "connectors",
      "desktop_synthetic",
      "manifest.json",
    );
    for (const [source, code] of [
      ["desktop-synthetic", "invalid_source_scope"],
      ["spotify", "source_collision"],
    ]) {
      await writeFile(
        manifest,
        JSON.stringify({
          ...profile,
          source: { id: `https://registry.pdpp.dev/sources/${source}` },
        }),
      );
      await expect(prepare()).rejects.toMatchObject({ code });
    }
    await writeFile(
      manifest,
      JSON.stringify({ ...profile, streams: [{ name: "bad-stream" }] }),
    );
    await expect(prepare()).rejects.toMatchObject({ code: "invalid_streams" });
  });

  it("refuses undeclared streams and incomplete builder output with no persisted handoff", async () => {
    inbox = path.join(directory, "invalid-inbox");
    await expect(prepare(["missing"])).rejects.toMatchObject({
      code: "invalid_streams",
    });
    await writeFile(
      path.join(checkout, "scripts", "build-connector-oci-artifact.mjs"),
      builder + 'fs.writeFileSync(path.join(out,".env"),"never ship");',
    );
    await expect(prepare()).rejects.toMatchObject({ code: "payload_invalid" });
    expect(await readdir(inbox)).toEqual([]);
  });
});
