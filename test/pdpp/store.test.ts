import { describe, expect, it } from "vitest";

import { satisfiesNodeRange } from "../../src/pdpp/host.js";
import {
  completedStreams,
  mergeRun,
  ownerKey,
  projectResult,
  type CollectionState,
} from "../../src/pdpp/store.js";

describe("satisfiesNodeRange", () => {
  it("accepts versions inside the provenance range", () => {
    expect(satisfiesNodeRange("24.15.0", ">=24.15.0 <25")).toBe(true);
    expect(satisfiesNodeRange("v24.21.0", ">=24.15.0 <25")).toBe(true);
  });

  it("rejects versions outside it, including the next major", () => {
    expect(satisfiesNodeRange("24.14.1", ">=24.15.0 <25")).toBe(false);
    expect(satisfiesNodeRange("25.0.0", ">=24.15.0 <25")).toBe(false);
  });

  it("fails closed on anything it cannot parse", () => {
    expect(satisfiesNodeRange("24.21.0", "^24.15.0")).toBe(false);
    expect(satisfiesNodeRange("0.24.3-vana", ">=24")).toBe(false);
    expect(satisfiesNodeRange("24.21.0", "")).toBe(false);
  });
});

const empty: CollectionState = { version: 1, checkpoints: {}, snapshot: {} };

function record(
  stream: string,
  key: string,
  data: Record<string, unknown>,
  op?: "delete",
) {
  return { stream, key, data, ...(op ? { op } : {}) };
}

describe("mergeRun", () => {
  it("keeps earlier records when an incremental run returns nothing new", () => {
    const first = mergeRun(empty, {
      mode: "incremental",
      completed: ["sleeps"],
      records: [
        record("sleeps", "1", { id: 1 }),
        record("sleeps", "2", { id: 2 }),
      ],
      checkpoints: { sleeps: { through: "2026-09-01" } },
    });
    const second = mergeRun(first, {
      mode: "incremental",
      completed: ["sleeps"],
      records: [],
      checkpoints: {},
    });
    expect(second.snapshot.sleeps.map((entry) => entry.key)).toEqual([
      "1",
      "2",
    ]);
    expect(second.checkpoints.sleeps).toEqual({ through: "2026-09-01" });
  });

  it("upserts by key and applies deletes", () => {
    const first = mergeRun(empty, {
      mode: "incremental",
      completed: ["sleeps"],
      records: [
        record("sleeps", "1", { id: 1, v: "old" }),
        record("sleeps", "2", { id: 2 }),
      ],
      checkpoints: {},
    });
    const second = mergeRun(first, {
      mode: "incremental",
      completed: ["sleeps"],
      records: [
        record("sleeps", "1", { id: 1, v: "new" }),
        record("sleeps", "2", { id: 2 }, "delete"),
      ],
      checkpoints: {},
    });
    expect(second.snapshot.sleeps).toEqual([
      { key: "1", data: { id: 1, v: "new" } },
    ]);
  });

  it("replaces a stream on a full refresh", () => {
    const first = mergeRun(empty, {
      mode: "incremental",
      completed: ["activities"],
      records: [record("activities", "1", { id: 1 })],
      checkpoints: {},
    });
    const second = mergeRun(first, {
      mode: "full_refresh",
      completed: ["activities"],
      records: [record("activities", "9", { id: 9 })],
      checkpoints: {},
    });
    expect(second.snapshot.activities.map((entry) => entry.key)).toEqual(["9"]);
  });

  it("leaves a skipped stream's records and cursor untouched", () => {
    const first = mergeRun(empty, {
      mode: "incremental",
      completed: ["sleeps", "cycles"],
      records: [
        record("sleeps", "1", { id: 1 }),
        record("cycles", "c", { id: "c" }),
      ],
      checkpoints: { cycles: { through: "a" } },
    });
    const second = mergeRun(first, {
      mode: "full_refresh",
      completed: ["sleeps"],
      records: [record("cycles", "d", { id: "d" })],
      checkpoints: { cycles: { through: "b" } },
    });
    expect(second.snapshot.cycles).toEqual(first.snapshot.cycles);
    expect(second.checkpoints.cycles).toEqual({ through: "a" });
  });
});

describe("completedStreams", () => {
  it("drops streams named by a skip", () => {
    expect(
      completedStreams(["a", "b"], [{ stream: "b", reason: "x" }]),
    ).toEqual(["a"]);
  });

  it("drops every stream when a skip names none", () => {
    expect(completedStreams(["a", "b"], [{ reason: "whole_run" }])).toEqual([]);
  });
});

describe("projectResult", () => {
  it("wraps each completed stream's records in an object under a dotted scope", () => {
    const state = mergeRun(empty, {
      mode: "incremental",
      completed: ["sleeps", "cycles"],
      records: [record("sleeps", "1", { id: 1 })],
      checkpoints: {},
    });
    const result = projectResult("whoop", "WHOOP", state, ["sleeps", "cycles"]);
    expect(result["whoop.sleeps"]).toEqual({ sleeps: [{ id: 1 }] });
    expect(result["whoop.cycles"]).toEqual({ cycles: [] });
    expect(result.completedStreams).toEqual(["sleeps", "cycles"]);
  });

  it("does not emit a scope for a stream that was not completed", () => {
    const result = projectResult("whoop", "WHOOP", empty, ["sleeps"]);
    expect(Object.keys(result).filter((key) => key.includes("."))).toEqual([
      "whoop.sleeps",
    ]);
  });
});

describe("ownerKey", () => {
  it("separates owners and ignores address casing", () => {
    const a = ownerKey("0x99Bf14e94DE7edB022E08528C5Cdb627f73A988d");
    expect(a).toBe(ownerKey("0x99bf14e94de7edb022e08528c5cdb627f73a988d"));
    expect(a).not.toBe(ownerKey("0xbffb000000000000000000000000000000000000"));
    expect(ownerKey(null)).toBe("unowned");
  });
});
