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

it("reports validated schema locations without relaying raw Factory errors", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "factory-preflight-"));
  const bin = path.join(root, "factory-build");
  await writeFile(
    bin,
    `#!${process.execPath}
const caps = { collectionVerificationVersion: 1, orderedTranscriptVersion: 1, supported: true, nodeVersion: 'v24.22.1', platform: 'darwin' };
const error = { code: 'unsupported_schema', message: 'PRIVATE_FACTORY_VALUE', diagnostic: { stream: 'highlights', path: 'schema.properties.text', keyword: 'pattern' } };
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
  expect(error.message).toContain("highlights.schema.properties.text");
  expect(error.message).toContain("pattern");
  expect(error.message).not.toContain("PRIVATE_FACTORY_VALUE");
});
