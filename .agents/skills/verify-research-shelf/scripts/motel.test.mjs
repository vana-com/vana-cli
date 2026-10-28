import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  validateObservation,
  observationLog,
  readObservations,
  diagnoseEvents,
  successfulDeliveries,
} from "./motel.mjs";

const run = randomUUID();
const attempt = randomUUID();
const requestAlias = "1".repeat(20);
const revisionAlias = "2".repeat(20);
const row = (patch = {}) => ({
  schema: 1,
  timestamp: new Date().toISOString(),
  eventId: randomUUID(),
  run,
  mode: "controlled",
  observer: "research-shelf",
  boundary: "consumer",
  stage: "read",
  outcome: "ok",
  attempt,
  requestAlias,
  grantAlias: "a".repeat(20),
  ...patch,
});

test("rejects private/unknown fields, raw identity and free-form reasons", () => {
  assert.throws(
    () => validateObservation(row({ payload: "PRIVATE_BODY" })),
    /unsupported fields/,
  );
  assert.throws(
    () => validateObservation(row({ requestAlias: "dcr_private" })),
    /requestAlias/,
  );
  assert.throws(
    () => validateObservation(row({ reason: "private_error_body" })),
    /reason/,
  );
  assert.throws(
    () => validateObservation(row({ observer: "gateway-server" })),
    /observer/,
  );
  const projected = observationLog(
    row({ stage: "save", outcome: "failed", reason: "save_failed" }),
  );
  assert.equal(projected.severityText, "ERROR");
  assert.equal(projected.body.stringValue, "research_shelf_save");
  assert.equal(
    projected.attributes.find((a) => a.key === "debug.session").value
      .stringValue,
    run,
  );
  assert(
    !("traceId" in projected),
    "No trace tree is invented from log associations",
  );
});

test("diagnoses served data followed by actual persistence failure in the same attempt", () => {
  const result = diagnoseEvents([
    row({ boundary: "personal-server" }),
    row({ stage: "save", outcome: "failed", reason: "save_failed" }),
  ]);
  assert.equal(result[0].diagnosis, "save-failed-after-read");
  assert.equal(result[0].evidence.length, 2);
});

test("does not correlate a different request or run merely because events are adjacent", () => {
  const failed = row({
    stage: "save",
    outcome: "failed",
    reason: "save_failed",
  });
  assert.equal(
    diagnoseEvents([row({ requestAlias: "3".repeat(20) }), failed])[0]
      .diagnosis,
    "unknown",
  );
  assert.equal(
    diagnoseEvents([row({ run: randomUUID() }), failed])[0].diagnosis,
    "unknown",
  );
});

test("acknowledgement failure requires explicit matching saved and rendered revision", () => {
  const ack = row({
    stage: "ack",
    outcome: "failed",
    reason: "ack_failed",
    revisionAlias,
    attempt: randomUUID(),
  });
  const save = row({ stage: "save", revisionAlias });
  const render = row({
    observer: "verifier",
    boundary: "browser",
    stage: "render",
    revisionAlias,
  });
  assert.equal(
    diagnoseEvents([save, render, ack])[0].diagnosis,
    "ack-failed-after-save-and-render",
  );
  assert.equal(
    diagnoseEvents([save, { ...render, revisionAlias: "4".repeat(20) }, ack])[0]
      .diagnosis,
    "unknown",
  );
});

test("interrupted read differs from HTTP refusal and from absent observations", () => {
  assert.equal(
    diagnoseEvents([
      row({ stage: "read", outcome: "interrupted", reason: "transport_error" }),
    ])[0].diagnosis,
    "read-interrupted-before-save",
  );
  assert.equal(
    diagnoseEvents([
      row({
        stage: "read",
        outcome: "failed",
        reason: "http_error",
        status: 503,
      }),
    ])[0].diagnosis,
    "read-failed-before-save",
  );
  assert.equal(diagnoseEvents([])[0].diagnosis, "unknown");
  assert.equal(
    diagnoseEvents([row({ outcome: "started" })])[0].diagnosis,
    "unknown",
  );
});

test("JSONL rejects partial, malformed, duplicate and wrong-run evidence without printing payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shelf-motel-test-"));
  const file = path.join(directory, "events.jsonl");
  try {
    const good = row();
    await writeFile(file, JSON.stringify(good) + "\n");
    assert.equal((await readObservations(file, run)).length, 1);
    await writeFile(file, JSON.stringify(good));
    await assert.rejects(readObservations(file, run), /unfinished/);
    await writeFile(file, "PRIVATE_PAYLOAD\n");
    await assert.rejects(
      readObservations(file, run),
      (error) =>
        /Malformed/.test(error.message) &&
        !/PRIVATE_PAYLOAD/.test(error.message),
    );
    await writeFile(
      file,
      JSON.stringify(good) + "\n" + JSON.stringify(good) + "\n",
    );
    await assert.rejects(readObservations(file, run), /repeats/);
    await writeFile(file, JSON.stringify(row({ run: randomUUID() })) + "\n");
    await assert.rejects(readObservations(file, run), /another run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost saved state is distinct from an acknowledgement service failure", () => {
  const save = row({ stage: "save", revisionAlias });
  const render = row({
    observer: "verifier",
    boundary: "browser",
    stage: "render",
    revisionAlias,
  });
  const failed = row({
    stage: "ack",
    outcome: "failed",
    reason: "save_required",
    revisionAlias,
    attempt: randomUUID(),
  });
  assert.equal(
    diagnoseEvents([save, render, failed])[0].diagnosis,
    "ack-refused-missing-save",
  );
});

test("a conflicting grant blocks a cross-boundary join despite identical request and revision", () => {
  const failed = row({
    stage: "ack",
    outcome: "failed",
    reason: "ack_failed",
    revisionAlias,
    attempt: randomUUID(),
  });
  const save = row({ stage: "save", revisionAlias });
  const wrongGrantRender = row({
    stage: "render",
    revisionAlias,
    grantAlias: "b".repeat(20),
    observer: "verifier",
    boundary: "browser",
  });
  assert.equal(
    diagnoseEvents([save, wrongGrantRender, failed])[0].diagnosis,
    "unknown",
  );
  assert.equal(
    diagnoseEvents([
      row({ grantAlias: "b".repeat(20) }),
      row({ stage: "save", outcome: "failed", reason: "save_failed" }),
    ])[0].diagnosis,
    "unknown",
  );
});

test("future retry rendering cannot explain an earlier acknowledgement failure", () => {
  const save = row({
    stage: "save",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.000Z",
  });
  const render = row({
    stage: "render",
    observer: "verifier",
    boundary: "browser",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.010Z",
  });
  const failure = row({
    stage: "ack",
    outcome: "failed",
    reason: "ack_failed",
    revisionAlias,
    attempt: randomUUID(),
    timestamp: "2026-10-28T07:00:00.020Z",
  });
  const future = {
    ...render,
    eventId: randomUUID(),
    timestamp: "2026-10-28T07:00:00.030Z",
  };
  assert.equal(diagnoseEvents([future, save, failure])[0].diagnosis, "unknown");
  const found = diagnoseEvents([future, save, failure, render])[0];
  assert.equal(found.diagnosis, "ack-failed-after-save-and-render");
  assert(found.evidence.includes(render.eventId));
  assert(!found.evidence.includes(future.eventId));
});

test("successful delivery requires matching identity, ordered read/save/render/ack, and keeps reload separate", () => {
  const read = row({ timestamp: "2026-10-28T07:00:00.000Z" });
  const save = row({
    stage: "save",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.010Z",
  });
  const render = row({
    stage: "render",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.020Z",
  });
  const ack = row({
    stage: "ack",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.030Z",
    attempt: randomUUID(),
  });
  const reload = row({
    stage: "reload",
    revisionAlias,
    timestamp: "2026-10-28T07:00:00.040Z",
  });
  assert.equal(
    successfulDeliveries([reload, ack, render, save, read]).length,
    1,
  );
  assert.equal(successfulDeliveries([reload, render, save, read]).length, 0);
  assert.equal(
    successfulDeliveries([
      read,
      save,
      { ...render, grantAlias: "b".repeat(20) },
      ack,
    ]).length,
    0,
  );
  assert.equal(
    successfulDeliveries([
      read,
      save,
      { ...render, timestamp: "2026-10-28T06:59:00.000Z" },
      ack,
    ]).length,
    0,
  );
  assert.equal(
    successfulDeliveries([read, save, render, ack])[0].reloadEvidence,
    null,
  );
});
