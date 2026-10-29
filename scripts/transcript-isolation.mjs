import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { writeSync } from "node:fs";

// Loaded before the captured CLI: even a stale build or a fixture that asks
// for a browser must stop before spawning it. This is an accidental-I/O guard,
// not a sandbox for untrusted connector code.
function refuse(kind) {
  writeSync(
    2,
    `${new Error(`VANA_TRANSCRIPT_ISOLATION: ${kind} is disabled during transcript capture.`).stack}\n`,
  );
  process.exit(1);
}

for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]) {
  childProcess[name] = () => refuse("Subprocess execution");
}
net.Socket.prototype.connect = () => refuse("Network access");
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  // status/doctor scan these default ports. The documentation scenario has
  // no Personal Server; answer from the fixture without opening a socket.
  if (
    method === "GET" &&
    /^http:\/\/localhost:808[0-5]\/health$/.test(url.href)
  ) {
    return Response.json(
      { error: "fixture_server_unavailable" },
      { status: 503 },
    );
  }
  return refuse("Network access");
};
syncBuiltinESMExports();
