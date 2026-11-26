export const title = "Stop a local Personal Server during automatic restart";

export function state(values) {
  if (values.launchedAfterStop) {
    return {
      launching: "Replacement starts after Stop",
      restarted: "Restart reported after Stop",
      stopped: "Replacement stopped again",
    }[values.phase];
  }
  if (values.phase === "probing" && values.stoppedAt !== "none") {
    return "Stop requested while restart checks a port";
  }
  if (values.phase === "backoff" && values.stoppedAt !== "none") {
    return "Stop requested during restart wait";
  }
  return {
    running: "Personal Server running",
    backoff: "Waiting before retry",
    probing: "Checking a port for restart",
    launching: "Starting a replacement",
    restarted: "Personal Server restarted",
    stopped: "Personal Server stopped",
  }[values.phase];
}

export const step = (action) =>
  ({
    ServerExits: "Server exits unexpectedly",
    RequestStop: "You stop the server",
    EndWait: "Restart wait settles",
    PortAvailable: "Port check returns",
    ServerReady: "Replacement answers",
    StopServer: "Supervisor stops the server",
    Done: "Finish",
  })[action];
