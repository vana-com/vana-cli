import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliEvent } from "../../src/core/cli-types.js";
import { PdppRuntime } from "../../src/pdpp/runtime.js";

// A checkout with one connector. It emits every chat it has not seen, judged
// by the cursor it gets back in START, which is how incremental runs work.
const CONNECTOR = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

const start = await next();
const seen = start.state.chat_events?.through ?? 0;
const chats = [1, 2, 3].filter((id) => id > seen);
if (process.env.FAKE_MANUAL === "1") {
  emit({ type: "INTERACTION", request_id: "int_1", kind: "manual_action", message: "Sign in to Fake." });
  const reply = await next();
  if (reply.status !== "success") {
    process.exitCode = 1;
    emit({ type: "DONE", status: "failed", records_emitted: 0, error: { message: "not signed in", retryable: false } });
    await new Promise((resolve) => rl.once("close", resolve));
    process.exit();
  }
}
emit({ type: "RECORD", stream: "profile", key: "me", data: { id: "me", trigger: process.env.PDPP_RUN_TRIGGER_KIND, profileRoot: process.env.PDPP_BROWSER_PROFILE_ROOT, leaked: process.env.PDPP_FAKE_REMOTE_CDP_URL ?? null }, emitted_at: "t" });
emit({ type: "PROGRESS", stream: "chat_events", message: "Reading chats" });
for (const id of chats) {
  emit({ type: "RECORD", stream: "chat_events", key: String(id), data: { id }, emitted_at: "t" });
}
emit({ type: "STATE", stream: "chat_events", cursor: { through: 3 } });
emit({ type: "DONE", status: "succeeded", records_emitted: 1 + chats.length });
await new Promise((resolve) => rl.once("close", resolve));
`;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The fake connector is TypeScript, run the way a checkout's connectors are:
// by Node's own type stripping (22.6+). Real runs always use Node 24; CI's
// Node 20 leg cannot load a .ts entry at all.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const stripsTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

describe.skipIf(!stripsTypes)("PdppRuntime from a local checkout", () => {
  let home: string;
  let checkout: string;
  const saved = {
    HOME: process.env.HOME,
    VANA_PDPP_NODE: process.env.VANA_PDPP_NODE,
    FAKE_MANUAL: process.env.FAKE_MANUAL,
    PDPP_FAKE_REMOTE_CDP_URL: process.env.PDPP_FAKE_REMOTE_CDP_URL,
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vana-pdpp-home-"));
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), "vana-pdpp-checkout-"));
    process.env.HOME = home;
    process.env.VANA_PDPP_NODE = process.execPath;
    // Would attach a real connector to someone's own browser; must not leak.
    process.env.PDPP_FAKE_REMOTE_CDP_URL = "http://127.0.0.1:9222";
    write(path.join(checkout, "connectors/fake/index.ts"), CONNECTOR);
    write(
      path.join(checkout, "connectors/fake/manifest.json"),
      JSON.stringify({
        connector_key: "fake",
        version: "0.0.1",
        display_name: "Fake",
        streams: [
          { name: "profile", display: { label: "Your profile" } },
          { name: "chat_events", display: { label: "Your chats" } },
        ],
      }),
    );
    // `--import tsx` only has to resolve; Node strips the types itself.
    write(
      path.join(checkout, "node_modules/tsx/package.json"),
      JSON.stringify({ name: "tsx", type: "module", exports: "./index.mjs" }),
    );
    write(path.join(checkout, "node_modules/tsx/index.mjs"), "");
    write(
      path.join(checkout, "package.json"),
      JSON.stringify({ type: "module", engines: { node: ">=20" } }),
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  async function connect(
    options: {
      noInput?: boolean;
      onNeedInput?: (request: {
        kind?: string;
        fields: string[];
      }) => Promise<Record<string, string>>;
    } = {},
  ) {
    const runtime = new PdppRuntime({ from: checkout, owner: "0xOwner" });
    await runtime.fetchConnector("fake");
    const events: CliEvent[] = [];
    for await (const event of runtime.runConnector({
      connectorPath: "",
      source: "fake",
      noInput: options.noInput,
      onNeedInput: options.onNeedInput,
    })) {
      events.push(event);
    }
    return events;
  }

  it("collects, writes dotted scopes, and resumes from the saved cursor", async () => {
    const first = await connect();
    const complete = first.find(
      (event) => event.type === "collection-complete",
    );
    expect(complete?.resultPath).toBeTruthy();
    const result = JSON.parse(
      fs.readFileSync(complete?.resultPath ?? "", "utf8"),
    );
    expect(result["fake.chat_events"]).toEqual({
      chat_events: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    expect(result["fake.profile"].profile[0]).toMatchObject({
      trigger: "manual",
      profileRoot: path.join(home, ".vana", "pdpp", "profiles"),
      leaked: null,
    });

    const second = await connect();
    const progress = second.filter((event) => event.type === "progress-update");
    expect(progress.at(-1)).toMatchObject({
      message: "Complete: 0 records",
      phase: { label: "Your chats", step: 2, total: 2 },
    });
    const rerun = JSON.parse(
      fs.readFileSync(
        second.find((event) => event.type === "collection-complete")
          ?.resultPath ?? "",
        "utf8",
      ),
    );
    // Nothing new came back, but the scope still carries every chat.
    expect(rerun["fake.chat_events"].chat_events).toHaveLength(3);
  });

  it("waits for the person on a manual step and passes the kind to the prompt", async () => {
    process.env.FAKE_MANUAL = "1";
    const asked: Array<{ kind?: string; fields: string[] }> = [];
    const events = await connect({
      onNeedInput: async (request) => {
        asked.push({ kind: request.kind, fields: request.fields });
        return {};
      },
    });
    expect(asked).toEqual([{ kind: "manual_action", fields: [] }]);
    expect(events.some((event) => event.type === "headed-required")).toBe(true);
    expect(events.some((event) => event.type === "collection-complete")).toBe(
      true,
    );
  });

  it("fails fast under --no-input instead of waiting for a sign-in", async () => {
    process.env.FAKE_MANUAL = "1";
    const events = await connect({ noInput: true });
    expect(events.some((event) => event.type === "legacy-auth")).toBe(true);
    expect(
      events.find((event) => event.type === "runtime-error")?.message,
    ).toBe("not signed in");
    expect(events.some((event) => event.type === "collection-complete")).toBe(
      false,
    );
  });

  it("answers a manual step over IPC through the response file", async () => {
    process.env.FAKE_MANUAL = "1";
    const runtime = new PdppRuntime({ from: checkout, owner: "0xOwner" });
    await runtime.fetchConnector("fake");
    const events: CliEvent[] = [];
    for await (const event of runtime.runConnector({
      connectorPath: "",
      source: "fake",
    })) {
      events.push(event);
      if (event.type === "needs-input" && event.responseInputPath) {
        expect(event.reason).toBe("manual_action");
        expect(fs.existsSync(event.pendingInputPath ?? "")).toBe(true);
        fs.writeFileSync(event.responseInputPath, "{}");
      }
    }
    expect(events.some((event) => event.type === "collection-complete")).toBe(
      true,
    );
  });

  it("does not commit state from a failed run", async () => {
    process.env.FAKE_MANUAL = "1";
    await connect({ noInput: true });
    process.env.FAKE_MANUAL = "0";
    const events = await connect();
    const result = JSON.parse(
      fs.readFileSync(
        events.find((event) => event.type === "collection-complete")
          ?.resultPath ?? "",
        "utf8",
      ),
    );
    expect(result["fake.chat_events"].chat_events).toHaveLength(3);
  });
});
