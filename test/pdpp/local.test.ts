import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLocalLaunch } from "../../src/pdpp/local.js";

const manifest = {
  connector_key: "instinct",
  version: "0.1.0",
  display_name: "Instinct",
  streams: [{ name: "profile" }, { name: "chat_events" }],
};

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("resolveLocalLaunch", () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vana-local-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs a root-layout connector through tsx from the checkout", async () => {
    const root = makeRoot();
    write(path.join(root, "connectors/instinct/index.ts"), "");
    write(
      path.join(root, "connectors/instinct/manifest.json"),
      JSON.stringify(manifest),
    );
    write(path.join(root, "node_modules/tsx/package.json"), "{}");
    write(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: ">=24.15.0 <25" } }),
    );

    const launch = await resolveLocalLaunch(root, "Instinct");
    expect(launch.origin).toBe("local");
    expect(launch.cwd).toBe(root);
    expect(launch.args).toEqual([
      "--import",
      "tsx",
      path.join(root, "connectors/instinct/index.ts"),
    ]);
    expect(launch.profile.streams.map((stream) => stream.name)).toEqual([
      "profile",
      "chat_events",
    ]);
    expect(launch.nodeRange).toBe(">=24.15.0 <25");
    expect(launch.installRoot).toBeNull();
  });

  it("finds the older packages/polyfill-connectors layout", async () => {
    const root = makeRoot();
    const pkg = path.join(root, "packages/polyfill-connectors");
    write(path.join(pkg, "connectors/instinct/index.ts"), "");
    write(path.join(pkg, "manifests/instinct.json"), JSON.stringify(manifest));
    write(path.join(pkg, "node_modules/tsx/package.json"), "{}");

    const launch = await resolveLocalLaunch(root, "instinct");
    expect(launch.cwd).toBe(pkg);
    expect(launch.displayName).toBe("Instinct");
  });

  it("says where it looked when the connector is missing", async () => {
    const root = makeRoot();
    await expect(resolveLocalLaunch(root, "nope")).rejects.toThrow(
      /connectors\/nope\/index\.ts/,
    );
  });

  it("refuses a checkout without tsx installed", async () => {
    const root = makeRoot();
    write(path.join(root, "connectors/instinct/index.ts"), "");
    write(
      path.join(root, "connectors/instinct/manifest.json"),
      JSON.stringify(manifest),
    );
    await expect(resolveLocalLaunch(root, "instinct")).rejects.toThrow(
      /tsx is not installed/,
    );
  });
});
