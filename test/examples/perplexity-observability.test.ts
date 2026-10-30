import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createShelfObserver } from "../../examples/perplexity-demo/src/server/observability.js";
import { createShelf } from "../../examples/perplexity-demo/src/server/delivery.js";

const RUN = "79e9cfda-d55c-4b2f-8a99-c79d36aaf001";
const PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "shelf-observation-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
function observer(file = path.join(directory, "events.jsonl")) {
  return createShelfObserver({
    file,
    run: RUN,
    mode: "controlled",
    salt: "a".repeat(64),
  });
}
function config(
  observe = observer(),
  storageDirectory = path.join(directory, "store"),
) {
  return {
    privateKey: PRIVATE_KEY,
    environment: "dev" as const,
    approvalUrl: "https://approval.example",
    gatewayUrl: "https://gateway.example",
    storageDirectory,
    allowPayment: false,
    observer: observe,
  };
}
async function events() {
  return (await readFile(path.join(directory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("Research Shelf boundary observations", () => {
  it("records actual request creation and durable connection saving", async () => {
    const shelf = createShelf(config());
    await shelf.connect(async () => ({ requestId: "dcr_private_request" }));
    const rows = await events();
    expect(rows.map((row) => [row.stage, row.outcome])).toEqual([
      ["approval", "started"],
      ["approval", "ok"],
      ["save", "started"],
      ["save", "ok"],
    ]);
    expect(rows[1].requestAlias).toMatch(/^[a-f0-9]{20}$/);
    expect(rows[1].attempt).toBe(rows[3].attempt);
  });
  it("retains actual save failure instead of declaring delivery successful", async () => {
    const blocked = path.join(directory, "not-a-directory");
    await writeFile(blocked, "occupied");
    await expect(
      createShelf(config(observer(), blocked)).connect(async () => ({
        requestId: "dcr_private_request",
      })),
    ).rejects.toThrow();
    const rows = await events();
    expect(rows.map((row) => [row.stage, row.outcome])).toContainEqual([
      "save",
      "failed",
    ]);
    expect(rows).not.toContainEqual(
      expect.objectContaining({ stage: "save", outcome: "ok" }),
    );
  });
  it("uses stable aliases without exporting raw identifiers or unknown data", async () => {
    const sink = observer();
    const input = {
      boundary: "consumer" as const,
      stage: "save" as const,
      outcome: "ok" as const,
      attempt: sink.attempt(),
      requestId: "dcr_private_request",
      grantId: "private-grant",
      revision: "private-revision",
      title: "private-title",
      cookie: "private-cookie",
    };
    await sink.observe(input);
    await sink.observe(input);
    const body = await readFile(path.join(directory, "events.jsonl"), "utf8");
    for (const secret of [
      "dcr_private_request",
      "private-grant",
      "private-revision",
      "private-title",
      "private-cookie",
    ])
      expect(body).not.toContain(secret);
    const rows = await events();
    expect(rows[0].requestAlias).toBe(rows[1].requestAlias);
    expect(rows[0].eventId).not.toBe(rows[1].eventId);
  });
  it("does not let unavailable observation change the original operation", async () => {
    const blocked = path.join(directory, "not-a-directory");
    await writeFile(blocked, "occupied");
    const sink = observer(path.join(blocked, "events.jsonl"));
    const result = await createShelf(config(sink)).connect(async () => ({
      requestId: "dcr_private_request",
    }));
    expect(result.request.requestId).toBe("dcr_private_request");
    await createShelfObserver().observe({
      boundary: "consumer",
      stage: "save",
      outcome: "ok",
      attempt: RUN,
    });
  });
});

describe("actual delivery failures retain distinct boundaries", () => {
  it.each(["save-failure", "ack-failure", "read-interrupted"] as const)(
    "records %s without claiming consumer completion",
    async (fault) => {
      const APP = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const OWNER = "0x1111111111111111111111111111111111111111";
      const GRANT = `0x${"1".repeat(64)}`;
      const BUILDER = `0x${"2".repeat(64)}`;
      const SERVER = "https://personal-server.example";
      const store = path.join(directory, "store");
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/consumer-ack"))
          return Response.json(
            {},
            { status: fault === "ack-failure" ? 503 : 200 },
          );
        if (url.endsWith("/api/data-connection-requests/dcr_private_request"))
          return Response.json({
            status: "approved",
            network: "moksha",
            delivery: "personal_server",
            personalServerUrl: SERVER,
            grantId: GRANT,
            scopes: ["perplexity.conversations"],
          });
        if (url.includes(`/v1/grants/${GRANT}`))
          return Response.json({
            data: {
              id: GRANT,
              grantorAddress: OWNER,
              granteeId: BUILDER,
              scopes: ["perplexity.conversations"],
              status: "pending",
              grantVersion: "1",
              expiresAt: null,
              expired: false,
              revokedAt: null,
              fee: {
                asset: "0x0000000000000000000000000000000000000000",
                totalDue: "0",
              },
            },
            proof: {},
          });
        if (url.includes(`/v1/builders/${APP}`))
          return Response.json({
            data: { id: BUILDER, granteeAddress: APP },
            proof: {},
          });
        if (url.includes(`/v1/servers?owner=${OWNER}`))
          return Response.json({
            active: [{ ownerAddress: OWNER, serverUrl: SERVER }],
            revoked: [],
            count: 1,
          });
        if (url === `${SERVER}/v1/data/perplexity.conversations`) {
          if (fault === "read-interrupted")
            throw new TypeError("private-transport-error-with-token");
          if (fault === "save-failure") {
            const name = (await readdir(store)).find((name) =>
              name.endsWith(".json"),
            );
            if (!name) throw Error("Missing synthetic connection");
            await rm(path.join(store, name));
            await mkdir(path.join(store, name));
          }
          return Response.json({
            scope: "perplexity.conversations",
            data: {
              conversations: [
                {
                  id: "private-record",
                  title: "private-title",
                  update_time: null,
                },
              ],
            },
          });
        }
        throw Error("Unexpected synthetic transport");
      });
      const shelf = createShelf(config());
      const connected = await shelf.connect(async () => ({
        requestId: "dcr_private_request",
      }));
      if (fault === "ack-failure") {
        const read = await shelf.read(connected.token, "dcr_private_request");
        await expect(
          shelf.acknowledge(connected.token, read.data.revision),
        ).rejects.toThrow();
      } else
        await expect(
          shelf.read(connected.token, "dcr_private_request"),
        ).rejects.toThrow();
      const rows = await events();
      if (fault === "save-failure") {
        expect(rows).toContainEqual(
          expect.objectContaining({ stage: "read", outcome: "ok" }),
        );
        expect(rows).toContainEqual(
          expect.objectContaining({
            stage: "save",
            outcome: "failed",
            revisionAlias: expect.any(String),
            reason: "save_failed",
          }),
        );
      } else if (fault === "ack-failure") {
        expect(rows).toContainEqual(
          expect.objectContaining({
            stage: "save",
            outcome: "ok",
            revisionAlias: expect.any(String),
          }),
        );
        expect(rows).toContainEqual(
          expect.objectContaining({ stage: "ack", outcome: "failed" }),
        );
      } else {
        expect(rows).toContainEqual(
          expect.objectContaining({
            stage: "read",
            outcome: "interrupted",
            reason: "transport_error",
          }),
        );
        expect(
          rows.filter((row) => row.stage === "save" && row.revisionAlias),
        ).toEqual([]);
      }
      expect(
        rows.filter((row) => row.stage === "ack" && row.outcome === "ok"),
      ).toEqual([]);
      const text = await readFile(path.join(directory, "events.jsonl"), "utf8");
      for (const secret of [
        "private-title",
        "private-record",
        "private-transport-error-with-token",
        GRANT,
        OWNER,
        APP,
        SERVER,
      ])
        expect(text).not.toContain(secret);
    },
  );
});
