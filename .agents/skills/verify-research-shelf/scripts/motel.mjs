#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SERVICE = "research-shelf-workflow";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const alias = /^[0-9a-f]{20}$/;
const fields = new Set([
  "schema",
  "timestamp",
  "eventId",
  "run",
  "mode",
  "observer",
  "boundary",
  "stage",
  "outcome",
  "attempt",
  "requestAlias",
  "grantAlias",
  "revisionAlias",
  "reason",
  "status",
  "count",
  "durationMs",
]);
const enums = {
  mode: ["controlled", "live"],
  observer: ["research-shelf", "verifier"],
  boundary: [
    "approval",
    "personal-server",
    "consumer",
    "browser",
    "collection",
    "ingestion",
  ],
  stage: [
    "approval",
    "read",
    "payment",
    "save",
    "render",
    "ack",
    "reload",
    "collection",
    "ingestion",
  ],
  outcome: ["started", "ok", "failed", "interrupted", "unknown"],
  reason: [
    "request_created",
    "pending",
    "approved",
    "completed",
    "denied",
    "expired",
    "cancelled",
    "approval_required",
    "grant_invalid",
    "server_invalid",
    "payment_disabled",
    "fee_cap_exceeded",
    "funding_required",
    "fee_quote_changed",
    "payment_invalid",
    "payment_unconfirmed",
    "http_error",
    "transport_error",
    "save_failed",
    "save_required",
    "connection_required",
    "invalid_request",
    "invalid_data",
    "network_refused",
    "read_failed",
    "ack_failed",
    "recovered",
    "already_acknowledged",
    "unknown_error",
  ],
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject unknown fields rather than copying arbitrary diagnostic content. */
export function validateObservation(input) {
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    "Observation must be an object",
  );
  assert(
    Object.keys(input).every((key) => fields.has(key)),
    "Observation has unsupported fields",
  );
  assert.equal(input.schema, 1, "Unsupported observation schema");
  assert(
    typeof input.timestamp === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.timestamp) &&
      Number.isFinite(Date.parse(input.timestamp)),
    "Invalid observation timestamp",
  );
  for (const key of ["eventId", "run", "attempt"])
    assert(
      typeof input[key] === "string" && uuid.test(input[key]),
      `Invalid ${key}`,
    );
  for (const [key, values] of Object.entries(enums))
    assert(
      (key === "reason" && input[key] === undefined) ||
        values.includes(input[key]),
      `Invalid ${key}`,
    );
  for (const key of ["requestAlias", "grantAlias", "revisionAlias"])
    assert(
      input[key] === undefined ||
        (typeof input[key] === "string" && alias.test(input[key])),
      `Invalid ${key}`,
    );
  for (const key of ["status", "count", "durationMs"])
    assert(
      input[key] === undefined ||
        (Number.isSafeInteger(input[key]) && input[key] >= 0),
      `Invalid ${key}`,
    );
  assert(
    input.status === undefined || (input.status >= 100 && input.status <= 599),
    "Invalid HTTP status",
  );
  return { ...input };
}

/** Read complete bounded JSONL. A partial final record is incomplete evidence. */
export async function readObservations(file, run) {
  assert(uuid.test(run), "Run must be a UUID");
  const bytes = await readFile(file);
  assert(bytes.length <= 16 * 1024 * 1024, "Observation input exceeds 16 MiB");
  assert(
    bytes.length === 0 || bytes.at(-1) === 10,
    "Observation input has an unfinished record",
  );
  const rows = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    assert(
      Buffer.byteLength(line) <= 16384,
      "Observation record exceeds 16 KiB",
    );
    let input;
    try {
      input = JSON.parse(line);
    } catch {
      throw new Error("Malformed observation JSON; raw content omitted");
    }
    const row = validateObservation(input);
    assert.equal(row.run, run, "Observation belongs to another run");
    rows.push(row);
  }
  assert.equal(
    new Set(rows.map((row) => row.eventId)).size,
    rows.length,
    "Input repeats an event identity",
  );
  return rows;
}

const attr = (key, value) => ({
  key,
  value:
    typeof value === "number"
      ? { intValue: String(value) }
      : { stringValue: value },
});
/** Project a validated record into OTLP without content or inferred spans. */
export function observationLog(input) {
  const row = validateObservation(input);
  const attributes = [
    attr("debug.session", row.run),
    attr("event.id", row.eventId),
    attr(
      "evidence.kind",
      row.mode === "controlled" ? "controlled-real-app" : "live-observation",
    ),
  ];
  for (const key of fields) {
    if (["timestamp", "eventId", "run"].includes(key) || row[key] === undefined)
      continue;
    attributes.push(attr(`shelf.${key}`, row[key]));
  }
  attributes.push(attr("evidence.recorded_at", row.timestamp));
  return {
    timeUnixNano: String(BigInt(Date.parse(row.timestamp)) * 1_000_000n),
    observedTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    severityText: ["failed", "interrupted"].includes(row.outcome)
      ? "ERROR"
      : row.outcome === "unknown"
        ? "WARN"
        : "INFO",
    body: { stringValue: `research_shelf_${row.stage}` },
    attributes,
  };
}

function loopback(value) {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Motel endpoint must be a literal HTTP loopback origin",
  );
  return url.origin;
}
async function getJson(endpoint, route) {
  const response = await fetch(new URL(route, endpoint), {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(
    response.status,
    200,
    `Motel query failed HTTP ${response.status}`,
  );
  return response.json();
}
/** Check collector identity without starting or stopping a service. */
export async function doctorMotel(endpoint) {
  const origin = loopback(endpoint);
  const health = await getJson(origin, "/api/health");
  assert(
    health.ok === true && health.service === "motel-local-server",
    "Unexpected Motel collector identity",
  );
  return {
    endpoint: origin,
    service: health.service,
    version: health.version ?? "unknown",
  };
}
async function portFree() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function closed(endpoint) {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(endpoint).port),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", done);
      resolve();
    }, ms);
    child.once("exit", done);
  });
}
/** Use an explicit healthy collector or own an isolated installed Motel server. */
export async function startMotel({ evidenceDir, endpoint }) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  if (endpoint) {
    const identity = {
      ...(await doctorMotel(endpoint)),
      mode: "shared-reused",
      owned: false,
    };
    await writeFile(
      path.join(evidenceDir, "motel-collector.json"),
      JSON.stringify(identity, null, 2),
      { mode: 0o600 },
    );
    return {
      endpoint: identity.endpoint,
      identity,
      cleanup: async () => ({ owned: false, preserved: true }),
    };
  }
  const binary =
    process.env.SHELF_MOTEL_BINARY ?? path.join(homedir(), ".local/bin/motel");
  await access(binary, constants.X_OK);
  const directory = path.join(evidenceDir, "motel-collector");
  await mkdir(directory, { mode: 0o700 });
  const origin = `http://127.0.0.1:${await portFree()}`;
  const database = path.join(directory, "telemetry.sqlite");
  let log = "",
    spawnError;
  const child = spawn(binary, ["server"], {
    detached: true,
    env: {
      ...process.env,
      PATH: `${path.join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}`,
      MOTEL_OTEL_BASE_URL: origin,
      MOTEL_OTEL_DB_PATH: database,
      MOTEL_OTEL_RETENTION_HOURS: "168",
      XDG_STATE_HOME: path.join(directory, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (bytes) => {
    log += bytes.toString();
  });
  child.stderr.on("data", (bytes) => {
    log += bytes.toString();
  });
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await waitExit(child, 4000);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await waitExit(child, 2000);
      }
    }
    await writeFile(path.join(directory, "collector.log"), log, {
      mode: 0o600,
    });
    const result = {
      owned: true,
      pid: child.pid ?? null,
      stopped:
        child.exitCode !== null ||
        child.signalCode !== null ||
        Boolean(spawnError),
      portReleased: await closed(origin),
      evidencePreserved: true,
    };
    await writeFile(
      path.join(evidenceDir, "motel-cleanup.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    return result;
  };
  try {
    const start = Date.now();
    let identity;
    while (Date.now() - start < 20000) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "Owned Motel process failed before readiness; inspect collector.log",
        );
      try {
        identity = await doctorMotel(origin);
        break;
      } catch {
        await pause(100);
      }
    }
    assert(
      identity,
      "Owned Motel collector did not become ready within 20 seconds",
    );
    const record = {
      ...identity,
      mode: "isolated-owned",
      owned: true,
      pid: child.pid,
      database,
      binary,
    };
    await writeFile(
      path.join(evidenceDir, "motel-collector.json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
    return { endpoint: origin, identity: record, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function fromQuery(row) {
  const attributes = row.attributes;
  assert(
    attributes && typeof attributes === "object",
    "Motel record has no attributes",
  );
  const event = {
    schema: Number(attributes["shelf.schema"]),
    timestamp: attributes["evidence.recorded_at"],
    eventId: attributes["event.id"],
    run: attributes["debug.session"],
  };
  for (const field of fields) {
    if (["schema", "timestamp", "eventId", "run"].includes(field)) continue;
    const value = attributes[`shelf.${field}`];
    if (value !== undefined)
      event[field] = ["status", "count", "durationMs"].includes(field)
        ? Number(value)
        : value;
  }
  return validateObservation(event);
}
const notAfter = (left, right) =>
  Date.parse(left.timestamp) <= Date.parse(right.timestamp);
const sameRevision = (left, right) =>
  left.run === right.run &&
  Boolean(left.requestAlias) &&
  left.requestAlias === right.requestAlias &&
  Boolean(left.grantAlias) &&
  left.grantAlias === right.grantAlias &&
  Boolean(left.revisionAlias) &&
  left.revisionAlias === right.revisionAlias;

/** Return only explicitly linked and ordered successful consumer deliveries. */
export function successfulDeliveries(events) {
  const rows = events.map(validateObservation);
  const chains = [];
  for (const save of rows.filter(
    (row) => row.stage === "save" && row.outcome === "ok" && row.revisionAlias,
  )) {
    const read = rows.find(
      (row) =>
        row.run === save.run &&
        row.attempt === save.attempt &&
        row.stage === "read" &&
        row.outcome === "ok" &&
        Boolean(row.requestAlias) &&
        row.requestAlias === save.requestAlias &&
        Boolean(row.grantAlias) &&
        row.grantAlias === save.grantAlias &&
        notAfter(row, save),
    );
    if (!read) continue;
    const render = rows.find(
      (row) =>
        sameRevision(row, save) &&
        row.stage === "render" &&
        row.outcome === "ok" &&
        notAfter(save, row),
    );
    if (!render) continue;
    const ack = rows.find(
      (row) =>
        sameRevision(row, save) &&
        row.stage === "ack" &&
        row.outcome === "ok" &&
        notAfter(render, row),
    );
    if (!ack) continue;
    const reload = rows.find(
      (row) =>
        sameRevision(row, save) &&
        row.stage === "reload" &&
        row.outcome === "ok" &&
        notAfter(ack, row),
    );
    chains.push({
      run: save.run,
      requestAlias: save.requestAlias,
      grantAlias: save.grantAlias,
      revisionAlias: save.revisionAlias,
      readAttempt: read.attempt,
      evidence: [read.eventId, save.eventId, render.eventId, ack.eventId],
      reloadEvidence: reload?.eventId ?? null,
    });
  }
  return chains;
}

/** Diagnose only explicit run/attempt/revision associations, never time adjacency. */
export function diagnoseEvents(events) {
  const rows = events.map(validateObservation);
  const result = [];
  const groups = Map.groupBy(rows, (row) => `${row.run}:${row.attempt}`);
  const linked = sameRevision;
  for (const attempt of groups.values()) {
    const failure = attempt.find((row) =>
      ["failed", "interrupted"].includes(row.outcome),
    );
    if (!failure) continue;
    let diagnosis = "unknown";
    const evidence = [failure.eventId];
    if (failure.stage === "save") {
      const read = attempt.find(
        (row) =>
          row.stage === "read" &&
          row.outcome === "ok" &&
          row.requestAlias === failure.requestAlias &&
          row.requestAlias &&
          row.grantAlias &&
          row.grantAlias === failure.grantAlias &&
          notAfter(row, failure),
      );
      if (read) {
        diagnosis = "save-failed-after-read";
        evidence.push(read.eventId);
      }
    } else if (failure.stage === "ack") {
      const save = rows.find(
        (row) =>
          linked(row, failure) &&
          row.stage === "save" &&
          row.outcome === "ok" &&
          notAfter(row, failure),
      );
      const render = rows.find(
        (row) =>
          linked(row, failure) &&
          row.stage === "render" &&
          row.outcome === "ok" &&
          notAfter(row, failure) &&
          (!save || notAfter(save, row)),
      );
      if (failure.reason === "save_required") {
        diagnosis = "ack-refused-missing-save";
      } else if (save && render) {
        diagnosis = "ack-failed-after-save-and-render";
        evidence.push(save.eventId, render.eventId);
      }
    } else if (
      failure.stage === "read" &&
      !attempt.some((row) => row.stage === "save" && row.outcome === "ok")
    ) {
      diagnosis =
        failure.outcome === "interrupted" ||
        failure.reason === "transport_error"
          ? "read-interrupted-before-save"
          : "read-failed-before-save";
    }
    result.push({
      run: failure.run,
      attempt: failure.attempt,
      diagnosis,
      evidence,
      attribution: failure.requestAlias ? "explicit-request" : "unattributed",
    });
  }
  if (!result.length)
    result.push({
      diagnosis: "unknown",
      evidence: [],
      attribution: "no-observed-failure",
    });
  return result;
}

/** Export selected metadata and query the actual collector until every ID is visible. */
export async function exportAndQuery({ file, run, endpoint, evidenceDir }) {
  const origin = loopback(endpoint);
  const events = await readObservations(file, run);
  await doctorMotel(origin);
  for (let offset = 0; offset < events.length; offset += 200) {
    const response = await fetch(new URL("/v1/logs", origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [attr("service.name", SERVICE)] },
            scopeLogs: [
              {
                scope: { name: "research-shelf-observations", version: "1" },
                logRecords: events
                  .slice(offset, offset + 200)
                  .map(observationLog),
              },
            ],
          },
        ],
      }),
    });
    assert(
      response.ok,
      `Motel rejected observation batch HTTP ${response.status}`,
    );
    const accepted = await response.json();
    assert.equal(
      Number(accepted.partialSuccess?.rejectedLogRecords ?? 0),
      0,
      "Motel partially rejected observations",
    );
  }
  const queries = [];
  const expected = new Set(events.map((row) => row.eventId));
  let records = [],
    projected = [],
    meta;
  const started = Date.now();
  do {
    records = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 50; page++) {
      const parameters = new URLSearchParams({
        service: SERVICE,
        "attr.debug.session": run,
        lookback: "1d",
        limit: "200",
      });
      if (cursor) parameters.set("cursor", cursor);
      const query = `/api/logs/search?${parameters}`;
      const response = await getJson(origin, query);
      queries.push(query);
      meta = response.meta;
      assert(Array.isArray(response.data), "Motel query omitted data");
      records.push(...response.data);
      cursor = response.meta?.nextCursor;
      if (!cursor) {
        assert(
          response.meta?.truncated !== true,
          "Motel query is truncated without a cursor",
        );
        break;
      }
      assert(!seen.has(cursor), "Motel query repeated a cursor");
      seen.add(cursor);
      assert(page < 49, "Motel query exceeds bounded pagination");
    }
    projected = records.map(fromQuery);
    if (
      [...expected].every((id) => projected.some((row) => row.eventId === id))
    )
      break;
    await pause(100);
  } while (Date.now() - started < 10000);
  const found = new Map(projected.map((row) => [row.eventId, row]));
  assert(
    [...expected].every((id) => found.has(id)),
    "Motel query did not return every exported event",
  );
  const diagnoses = diagnoseEvents([...found.values()]);
  const report = {
    service: SERVICE,
    endpoint: origin,
    run,
    imported: events.length,
    returned: records.length,
    unique: found.size,
    duplicates: projected.length - found.size,
    queries,
    complete: true,
    coverage: [
      ...new Set(projected.map((row) => `${row.boundary}:${row.stage}`)),
    ].sort(),
    diagnoses,
    successfulDeliveries: successfulDeliveries([...found.values()]),
    events: [...found.values()],
    queryMeta: meta,
    productVerdict: "requires-independent-browser-and-storage-assertions",
  };
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(evidenceDir, "motel-query.json"),
    JSON.stringify({ queries, records, meta }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(evidenceDir, "motel-result.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      file: { type: "string" },
      run: { type: "string" },
      endpoint: { type: "string" },
      evidence: { type: "string" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node motel.mjs --file <observations.jsonl> --run <UUID> --endpoint http://127.0.0.1:<port> --evidence <directory>\nImports metadata into an existing Motel collector. Does not drive an app or authorize a live run.",
    );
  else {
    try {
      const result = await exportAndQuery({
        file: values.file,
        run: values.run,
        endpoint: values.endpoint,
        evidenceDir: values.evidence,
      });
      console.log(
        JSON.stringify({
          imported: result.imported,
          complete: result.complete,
          diagnoses: result.diagnoses,
        }),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
