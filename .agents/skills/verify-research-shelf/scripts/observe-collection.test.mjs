import test from "node:test";
import assert from "node:assert/strict";
import { collectionSignal } from "./observe-collection.mjs";

test("collection success never implies ingestion success", () => {
  assert.deepEqual(
    collectionSignal({
      type: "collection-complete",
      source: "perplexity",
      data: { title: "private" },
      resultPath: "/private/data",
    }),
    { boundary: "collection", stage: "collection", outcome: "ok" },
  );
  assert.equal(
    collectionSignal({ type: "outcome", status: "connected_and_ingested" }),
    null,
  );
});
test("skipped and partial ingestion stay incomplete", () => {
  assert.equal(collectionSignal({ type: "ingest-skipped" }).outcome, "unknown");
  assert.equal(collectionSignal({ type: "ingest-partial" }).outcome, "failed");
  assert.equal(collectionSignal({ type: "ingest-complete" }).outcome, "ok");
});
test("unrelated sources and payloads supply no metadata", () => {
  assert.equal(
    collectionSignal({ type: "collection-complete", source: "spotify" }),
    null,
  );
  assert.equal(
    collectionSignal({
      type: "record",
      title: "private",
      Authorization: "secret",
    }),
    null,
  );
});

test("prototype property names are not collection signals", () => {
  for (const type of ["__proto__", "constructor", "toString"])
    assert.equal(collectionSignal({ type }), null);
});
