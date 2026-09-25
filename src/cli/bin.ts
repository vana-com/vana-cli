#!/usr/bin/env node

import { runCli } from "./index.js";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

const exitCode = await runCli(process.argv);
if (typeof exitCode === "number") {
  process.exitCode = exitCode;
}

// The command is done and its telemetry sent. Anything a library left open
// (a timer, a socket, a stdin listener) must not keep the terminal waiting:
// after a short grace for output to drain, leave. The timer itself does not
// hold the process, so a clean exit still happens at once.
// VANA_DEBUG_HANDLES=1 names what was still open.
setTimeout(() => {
  if (process.env.VANA_DEBUG_HANDLES) {
    const handles = (
      process as unknown as { _getActiveHandles(): unknown[] }
    )._getActiveHandles();
    process.stderr.write(
      `[vana] still open at exit: ${handles
        .map((handle) => (handle as object)?.constructor?.name ?? typeof handle)
        .join(", ")}\n`,
    );
  }
  process.exit();
}, 2_000).unref();
