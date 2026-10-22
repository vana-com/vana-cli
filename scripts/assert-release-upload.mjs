import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise the installed release plugin before it can create a real tag/draft.
// Native fetch must initialize first: mixed undici versions otherwise hide the
// duplicate Content-Length regression in the upload transport.
const directory = await mkdtemp(path.join(tmpdir(), "vana-release-upload-"));
const bytes = Buffer.from([0, 1, 127, 128, 255, 10]);
const fixtures = new Map([
  ["asset.bin", bytes],
  [
    "asset.bin.sha256",
    Buffer.from(createHash("sha256").update(bytes).digest("hex")),
  ],
]);
const received = new Set();
let published = false;
let origin;
const repositoryUrl = "https://github.com/preflight/release-upload.git";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.method === "GET" && url.pathname === "/prime")
    return send(200, {});
  if (
    request.method === "GET" &&
    url.pathname === "/repos/preflight/release-upload"
  ) {
    return send(200, { clone_url: repositoryUrl, permissions: { push: true } });
  }
  if (
    request.method === "POST" &&
    url.pathname === "/repos/preflight/release-upload/releases"
  ) {
    return send(201, {
      id: 1,
      html_url: `${origin}/release`,
      upload_url: `${origin}/assets{?name,label}`,
    });
  }
  if (request.method === "POST" && url.pathname === "/assets") {
    const name = url.searchParams.get("name");
    const expected = fixtures.get(name);
    if (
      !expected ||
      !body.equals(expected) ||
      request.headers["content-length"] !== String(expected.length)
    ) {
      return send(400, {
        message: "Uploaded asset bytes or Content-Length did not match",
      });
    }
    received.add(name);
    return send(201, { browser_download_url: `${origin}/downloads/${name}` });
  }
  if (
    request.method === "PATCH" &&
    url.pathname === "/repos/preflight/release-upload/releases/1"
  ) {
    if (received.size !== fixtures.size || JSON.parse(body).draft !== false) {
      return send(400, {
        message: "Release published before both assets arrived",
      });
    }
    published = true;
    return send(200, { html_url: `${origin}/release` });
  }
  return send(404, { message: "Unexpected preflight request" });
});
const timeout = setTimeout(() => {
  console.error("Release upload preflight timed out");
  process.exit(1);
}, 60000);
timeout.unref();

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${origin}/prime`).then((response) => response.json());
  for (const [name, content] of fixtures)
    await writeFile(path.join(directory, name), content);
  const { publish } = await import("@semantic-release/github");
  await publish(
    { githubApiUrl: origin, proxy: false, assets: [...fixtures.keys()] },
    {
      cwd: directory,
      env: { GITHUB_TOKEN: "local-preflight-token" },
      options: { repositoryUrl },
      branch: { name: "main", type: "release", main: true },
      nextRelease: {
        gitTag: "v0.0.0-preflight",
        name: "preflight",
        notes: "local only",
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );
  assert.deepEqual(received, new Set(fixtures.keys()));
  assert.equal(published, true);
  console.log(
    `Release plugin uploaded binary and checksum bytes before publication on Node ${process.versions.node}.`,
  );
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
