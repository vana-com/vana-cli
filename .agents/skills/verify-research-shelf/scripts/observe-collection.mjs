#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

/** Select only terminal observations emitted by the fixed Perplexity CLI invocation. */
export function collectionSignal(row) {
  if (
    !row ||
    typeof row !== "object" ||
    (row.source && row.source !== "perplexity")
  )
    return null;
  const signals = {
    "collection-complete": {
      boundary: "collection",
      stage: "collection",
      outcome: "ok",
    },
    "collection-error": {
      boundary: "collection",
      stage: "collection",
      outcome: "failed",
      reason: "unknown_error",
    },
    "ingest-complete": {
      boundary: "ingestion",
      stage: "ingestion",
      outcome: "ok",
    },
    "ingest-partial": {
      boundary: "ingestion",
      stage: "ingestion",
      outcome: "failed",
      reason: "unknown_error",
    },
    "ingest-failed": {
      boundary: "ingestion",
      stage: "ingestion",
      outcome: "failed",
      reason: "unknown_error",
    },
    "ingest-skipped": {
      boundary: "ingestion",
      stage: "ingestion",
      outcome: "unknown",
      reason: "unknown_error",
    },
  };
  return typeof row.type === "string" && Object.hasOwn(signals, row.type)
    ? signals[row.type]
    : null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      context: { type: "string" },
      from: { type: "string" },
      "allow-collection": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node observe-collection.mjs --context <private-context.json> --from <existing-connector-checkout> --allow-collection\nRuns real Perplexity conversation collection and ingestion. Requires separate exact account/scope authorization. No paid app read. Exports only allowlisted CLI terminal observations.",
    );
    return;
  }
  assert(
    values["allow-collection"],
    "Real collection requires --allow-collection after scoped authorization",
  );
  assert(
    values.context && path.isAbsolute(values.context),
    "Use an absolute private context file",
  );
  assert(
    values.from && path.isAbsolute(values.from),
    "Use the reviewed absolute connector checkout",
  );
  const context = JSON.parse(await readFile(values.context, "utf8"));
  assert(
    context.mode === "live",
    "Real collection requires a live observation context",
  );
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "shelf-collection-observer-"),
  );
  try {
    const source = await readFile(
      path.join(root, "examples/perplexity-demo/src/server/observability.ts"),
      "utf8",
    );
    const moduleFile = path.join(directory, "observer.mjs");
    await writeFile(
      moduleFile,
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    );
    const { createShelfObserver } = await import(
      pathToFileURL(moduleFile).href
    );
    assert(
      typeof context.file === "string" && path.isAbsolute(context.file),
      "Observation file must be absolute",
    );
    assert(
      /^[a-f0-9]{64}$/i.test(context.salt),
      "Context needs its private run salt",
    );
    assert(/^[a-f0-9-]{36}$/i.test(context.run), "Context needs its run UUID");
    const observer = createShelfObserver(context);
    const attempt = randomUUID();
    const link = {
      observer: "verifier",
      attempt,
      requestId: context.requestId,
      grantId: context.grantId,
    };
    await observer.observe({
      ...link,
      boundary: "collection",
      stage: "collection",
      outcome: "started",
    });
    const child = spawn(
      process.execPath,
      [
        path.join(root, "dist/cli/bin.js"),
        "connect",
        "perplexity",
        "--from",
        values.from,
        "--streams",
        "conversations",
        "--network",
        "moksha",
        "--json",
        "--ipc",
      ],
      {
        cwd: root,
        env: { ...process.env, VANA_ENV: "dev", VANA_TELEMETRY_DISABLED: "1" },
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const lines = createInterface({ input: child.stdout });
    const observed = new Set();
    const reading = (async () => {
      for await (const line of lines) {
        if (line.length > 2 * 1024 * 1024) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const signal = collectionSignal(row);
        if (signal) {
          await observer.observe({ ...link, ...signal });
          observed.add(`${signal.stage}:${signal.outcome}`);
        }
        if (row.type === "needs-input")
          console.log(
            JSON.stringify({
              type: "needs-input",
              pendingInputPath: row.pendingInputPath,
              responseInputPath: row.responseInputPath,
            }),
          );
      }
    })();
    child.stderr.resume();
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let result;
    try {
      result = await exited;
      await reading;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      lines.close();
    }
    if (result.signal)
      await observer.observe({
        ...link,
        boundary: "collection",
        stage: "collection",
        outcome: "interrupted",
        reason: "transport_error",
      });
    if (!observed.has("collection:ok"))
      await observer.observe({
        ...link,
        boundary: "collection",
        stage: "collection",
        outcome: result.code === 0 ? "unknown" : "failed",
        reason: "unknown_error",
      });
    if (!observed.has("ingestion:ok"))
      await observer.observe({
        ...link,
        boundary: "ingestion",
        stage: "ingestion",
        outcome: "unknown",
        reason: "unknown_error",
      });
    console.log(
      JSON.stringify({
        command: "perplexity-conversations-collection",
        code: result.code,
        signal: result.signal,
        observed: [...observed],
        payloadLogged: false,
      }),
    );
    process.exitCode = result.code ?? 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
