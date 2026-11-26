---- MODULE ServerSupervision ----
CONSTANTS StopAfterBackoff, StopAfterPortProbe
VARIABLES phase, stoppedAt, launchedAfterStop
vars == <<phase, stoppedAt, launchedAfterStop>>

Init == phase = "running" /\ stoppedAt = "none" /\ launchedAfterStop = FALSE

ServerExits ==
  /\ phase = "running"
  /\ stoppedAt = "none"
  /\ phase' = "backoff"
  /\ UNCHANGED <<stoppedAt, launchedAfterStop>>

RequestStop ==
  /\ phase \in {"running", "backoff", "probing", "launching", "restarted"}
  /\ stoppedAt = "none"
  /\ stoppedAt' = phase
  /\ UNCHANGED <<phase, launchedAfterStop>>

EndWait ==
  /\ phase = "backoff"
  /\ phase' = IF stoppedAt = "backoff" /\ StopAfterBackoff THEN "stopped" ELSE "probing"
  /\ UNCHANGED <<stoppedAt, launchedAfterStop>>

PortAvailable ==
  /\ phase = "probing"
  /\ phase' = IF stoppedAt # "none" /\ StopAfterPortProbe THEN "stopped" ELSE "launching"
  /\ launchedAfterStop' = (phase' = "launching" /\ stoppedAt # "none")
  /\ UNCHANGED stoppedAt

ServerReady ==
  /\ phase = "launching"
  /\ phase' = "restarted"
  /\ UNCHANGED <<stoppedAt, launchedAfterStop>>

StopServer ==
  /\ phase \in {"running", "restarted"}
  /\ stoppedAt # "none"
  /\ phase' = "stopped"
  /\ UNCHANGED <<stoppedAt, launchedAfterStop>>

Done ==
  /\ phase \in {"stopped", "restarted"}
  /\ UNCHANGED vars

Next == ServerExits \/ RequestStop \/ EndWait \/ PortAvailable
        \/ ServerReady \/ StopServer \/ Done
Spec == Init /\ [][Next]_vars
NoLaunchAfterStop == ~launchedAfterStop
BackoffStopPreventsLaunch == (stoppedAt = "backoff") => ~launchedAfterStop
====
