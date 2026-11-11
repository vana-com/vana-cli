-------------------------- MODULE ExportSettlement --------------------------
CONSTANTS SameOwner, GuardPublish, GuardSettle

VARIABLES stage, receipt, visibleGeneration, visibleStatus, foreignReplacement

vars == <<stage, receipt, visibleGeneration, visibleStatus, foreignReplacement>>
Attempts == {"earlier", "later"}
Statuses == {"none", "local", "stored", "failed"}
Phases == {"running", "local", "admitted", "uploading", "response-stored",
           "response-failed", "settled", "refused", "superseded"}

Init ==
  /\ stage = [id \in Attempts |-> "running"]
  /\ receipt = "none"
  /\ visibleGeneration = "none"
  /\ visibleStatus = "none"
  /\ foreignReplacement = FALSE

CompleteCollection(id) ==
  /\ stage[id] = "running"
  /\ stage' = [stage EXCEPT ![id] = "local"]
  /\ UNCHANGED <<receipt, visibleGeneration, visibleStatus, foreignReplacement>>

ForeignPending(id) ==
  /\ receipt \in Attempts
  /\ receipt # id
  /\ ~SameOwner
  /\ visibleStatus \in {"local", "failed"}

PublishReceipt(id) ==
  /\ stage[id] = "local"
  /\ (~GuardPublish \/ ~ForeignPending(id))
  /\ stage' = [stage EXCEPT ![id] = "admitted"]
  /\ receipt' = id
  /\ visibleGeneration' = id
  /\ visibleStatus' = "local"
  /\ foreignReplacement' = (foreignReplacement \/ ForeignPending(id))

RefusePublication(id) ==
  /\ stage[id] = "local"
  /\ GuardPublish /\ ForeignPending(id)
  /\ stage' = [stage EXCEPT ![id] = "refused"]
  /\ UNCHANGED <<receipt, visibleGeneration, visibleStatus, foreignReplacement>>

StartUpload(id) ==
  /\ stage[id] = "admitted"
  /\ stage' = [stage EXCEPT ![id] = "uploading"]
  /\ UNCHANGED <<receipt, visibleGeneration, visibleStatus, foreignReplacement>>

ReceiveUploadResult(id, ok) ==
  /\ stage[id] = "uploading"
  /\ stage' = [stage EXCEPT ![id] = IF ok THEN "response-stored" ELSE "response-failed"]
  /\ UNCHANGED <<receipt, visibleGeneration, visibleStatus, foreignReplacement>>

SettleResult(id) ==
  /\ stage[id] \in {"response-stored", "response-failed"}
  /\ (~GuardSettle \/ receipt = id)
  /\ stage' = [stage EXCEPT ![id] = "settled"]
  /\ visibleGeneration' = id
  /\ visibleStatus' = IF stage[id] = "response-stored" THEN "stored" ELSE "failed"
  /\ UNCHANGED <<receipt, foreignReplacement>>

RejectStaleResult(id) ==
  /\ stage[id] \in {"response-stored", "response-failed"}
  /\ GuardSettle /\ receipt # id
  /\ stage' = [stage EXCEPT ![id] = "superseded"]
  /\ UNCHANGED <<receipt, visibleGeneration, visibleStatus, foreignReplacement>>

Done ==
  /\ \A id \in Attempts : stage[id] \in {"settled", "refused", "superseded"}
  /\ UNCHANGED vars

Next ==
  \/ \E id \in Attempts :
       CompleteCollection(id) \/ PublishReceipt(id) \/ RefusePublication(id) \/
       StartUpload(id) \/ SettleResult(id) \/ RejectStaleResult(id)
  \/ \E id \in Attempts, ok \in BOOLEAN : ReceiveUploadResult(id, ok)
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ stage \in [Attempts -> Phases]
  /\ receipt \in Attempts \cup {"none"}
  /\ visibleGeneration \in Attempts \cup {"none"}
  /\ visibleStatus \in Statuses
  /\ foreignReplacement \in BOOLEAN

VisibleResultMatchesReceipt == visibleGeneration = receipt
ForeignPendingReceiptPreserved == ~foreignReplacement
=============================================================================
