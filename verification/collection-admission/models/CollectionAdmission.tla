---- MODULE CollectionAdmission ----
CONSTANTS RequireForeignConsent, RecheckAccount
VARIABLES phase, interactive, initialSession, target, consent, probed, ownerChanged
vars == <<phase, interactive, initialSession, target, consent, probed, ownerChanged>>

Init ==
  /\ phase = "session"
  /\ interactive \in BOOLEAN
  /\ initialSession \in {"signed-in", "signed-out", "unknown-owner"}
  /\ target = "none"
  /\ consent = FALSE
  /\ probed = FALSE
  /\ ownerChanged = FALSE

ReadSession ==
  /\ phase = "session"
  /\ phase' = CASE initialSession = "signed-in" -> "detect"
                   [] initialSession = "signed-out" /\ interactive -> "sign-in"
                   [] OTHER -> "refused"
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

SignIn ==
  /\ phase = "sign-in"
  /\ phase' \in {"detect", "refused"}
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

DetectServer(result) ==
  /\ phase \in {"detect", "redetect"}
  /\ target' = result
  /\ phase' = CASE result = "none" /\ phase = "detect" /\ interactive -> "prepare"
                   [] result \in {"none", "unknown-owner"} -> "refused"
                   [] result = "foreign" -> "foreign"
                   [] OTHER -> "probe"
  /\ UNCHANGED <<interactive, initialSession, consent, probed, ownerChanged>>

PrepareServer ==
  /\ phase = "prepare"
  /\ phase' = "redetect"
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

DecideForeignConsent ==
  /\ phase = "foreign"
  /\ consent' \in (IF interactive THEN BOOLEAN ELSE {FALSE})
  /\ phase' = IF consent' \/ ~RequireForeignConsent THEN "probe" ELSE "refused"
  /\ UNCHANGED <<interactive, initialSession, target, probed, ownerChanged>>

StartProbe ==
  /\ phase \in {"probe", "reprobe"}
  /\ phase' = IF phase = "probe" THEN "checking" ELSE "rechecking"
  /\ probed' = TRUE
  /\ UNCHANGED <<interactive, initialSession, target, consent, ownerChanged>>

ProbeReturns(result) ==
  /\ phase \in {"checking", "rechecking"}
  /\ phase' = CASE result = "ready" -> "verify"
                   [] phase = "checking" /\ result = "auth" /\ interactive -> "approve"
                   [] OTHER -> "refused"
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

ApproveServer ==
  /\ phase = "approve"
  /\ phase' \in {"reprobe", "refused"}
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

AccountChanges ==
  /\ phase \in {"checking", "approve", "rechecking"}
  /\ ~ownerChanged
  /\ ownerChanged' = TRUE
  /\ UNCHANGED <<phase, interactive, initialSession, target, consent, probed>>

VerifyOwner ==
  /\ phase = "verify"
  /\ phase' = IF ownerChanged /\ RecheckAccount THEN "refused" ELSE "ready"
  /\ UNCHANGED <<interactive, initialSession, target, consent, probed, ownerChanged>>

Done ==
  /\ phase \in {"ready", "refused"}
  /\ UNCHANGED vars

Next ==
  \/ ReadSession
  \/ SignIn
  \/ \E result \in {"none", "unknown-owner", "own", "foreign"} : DetectServer(result)
  \/ PrepareServer
  \/ DecideForeignConsent
  \/ StartProbe
  \/ \E result \in {"ready", "auth", "unavailable"} : ProbeReturns(result)
  \/ ApproveServer
  \/ AccountChanges
  \/ VerifyOwner
  \/ Done

Spec == Init /\ [][Next]_vars
ForeignProbeNeedsConsent == (target = "foreign" /\ probed) => (interactive /\ consent)
CurrentOwnerAtAdmission == (phase = "ready") => ~ownerChanged
====
