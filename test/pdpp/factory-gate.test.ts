import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FactoryCollectionGate } from "../../src/pdpp/factory-gate.js";

let root: string | undefined;
const original = process.env.VANA_FACTORY_BUILD;
afterEach(async () => {
  if (original === undefined) delete process.env.VANA_FACTORY_BUILD;
  else process.env.VANA_FACTORY_BUILD = original;
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([
  {
    code: "unsupported_schema",
    diagnostic: {
      stream: "highlights",
      path: "schema.properties.text",
      keyword: "pattern",
    },
    expected: ["highlights.schema.properties.text", "pattern"],
  },
  {
    code: "checks_stale",
    expected: ["checks are stale", "check command", "No connector was started"],
  },
  {
    code: "operation_failed",
    expected: [
      "could not complete collection preflight",
      "private work file",
      "No connector was started",
    ],
  },
])(
  "reports $code safely instead of parsing a refusal as an attempt",
  async ({ code, diagnostic, expected }) => {
    root = await mkdtemp(path.join(os.tmpdir(), "factory-preflight-"));
    const bin = path.join(root, "factory-build");
    await writeFile(
      bin,
      `#!${process.execPath}
const caps = { collectionVerificationVersion: 1, orderedTranscriptVersion: 1, supported: true, nodeVersion: 'v24.22.1', platform: 'darwin' };
const error = ${JSON.stringify({ code, message: "PRIVATE_FACTORY_VALUE", ...(diagnostic ? { diagnostic } : {}) })};
console.log(JSON.stringify(process.argv[2] === 'capabilities' ? caps : { version: 1, error }));
process.exitCode = process.argv[2] === 'capabilities' ? 0 : 1;
`,
      { mode: 0o700 },
    );
    process.env.VANA_FACTORY_BUILD = bin;
    const error = await FactoryCollectionGate.begin(
      { jobId: "11111111-1111-4111-8111-111111111111", stateDirectory: root },
      {},
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error))
      throw new Error("Expected preflight rejection");
    for (const text of expected) expect(error.message).toContain(text);
    expect(error.message).not.toContain("PRIVATE_FACTORY_VALUE");
  },
);
