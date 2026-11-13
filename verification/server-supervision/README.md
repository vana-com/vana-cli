# Local Personal Server supervision

**Bug and tracking issue.** If `vana server stop` arrives while the CLI is
looking for a free port during a restart, it still launches a replacement
server. The user sees "Restarted…" and then "Stopped.", and no process is left
running. `vana server stop` can report that the server did not stop in time.
The code is the supervisor in the CLI (`src/cli/server-start.ts`). Tracked in
[BUI-1011](https://linear.app/vana-team/issue/BUI-1011).

When Stop arrives before a replacement process starts, the supervisor must
keep it from launching. Otherwise `vana server stop` can be followed by
`server-restarted` before the supervisor stops the replacement.

| Model action                | CLI source                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ServerExits`               | `runServerStart` receives the running child's exit and stops that handle before backoff.                                                         |
| `RequestStop`               | `stopRequested` settles and records `stopping` in the supervisor. The data directory remains locked.                                             |
| `EndWait`                   | The restart sleep races Stop. The branch returns success and emits `server-stopped` when Stop wins.                                              |
| `PortAvailable`             | Restart awaits `choosePort` and may try a second port. On a usable port, it calls `launch` without rechecking Stop.                              |
| `ServerReady`, `StopServer` | The replacement supplies credentials and emits `server-restarted`. The next loop observes Stop, stops the new handle and emits `server-stopped`. |

TLC explores one foreground server, one unexpected exit, one restart wait,
one successful port probe, one replacement launch and one stop request. It
starts after initial readiness. An already invoked launch may finish after
Stop. The invariant concerns a new launch invoked after Stop. Runtime install,
the detached child handshake, registration, tunnels, actual OS signal delivery,
multiple restarts and a failed port probe are outside this model.

## Read the current finding

`NoLaunchAfterStop` breaks. A server exits, the backoff ends, Stop arrives
while the replacement's port probe is pending, and the usable result starts a
replacement. The command replay holds the real `runServerStart` restart
workflow at that exact dependency boundary. The injected transport observes
`server-restarted` before `server-stopped`. The first server and replacement
are controlled handles. No OS process, provider, browser or tunnel is started.

The existing backoff guard holds. The checker removes it in scratch and
requires the wait replay to observe an unwanted restart. The checker also
tries a scratch guard immediately after the port probe, before any launch.
That variation passes the port-probe replay. The checker restores all source
bytes and repeats both baseline outcomes. The guarded replay also checks that the start port received no second call.
The scratch guard isolates the counterexample's cause. It is outside the delivered runtime source.
