---- MODULE MainnetRegistration ----
EXTENDS Naturals

CONSTANTS SaveContext, AwaitProof, MatchProof, ReadBeforePost
VARIABLES phase, gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation
vars == <<phase, gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

Init == /\ phase = "idle"
        /\ gateway = "absent"
        /\ saved = FALSE
        /\ attempts = 0
        /\ proof = FALSE
        /\ unsafePost = FALSE
        /\ duplicatePost = FALSE
        /\ unsafeAssociation = FALSE

AdmitOriginalApp == /\ phase \in {"idle", "stopped"}
                    /\ attempts < 2
                    /\ phase' = "admitted"
                    /\ attempts' = attempts + 1
                    /\ proof' = FALSE
                    /\ UNCHANGED <<gateway, saved, unsafePost, duplicatePost, unsafeAssociation>>

SaveIdentity == /\ phase = "admitted"
                /\ phase' = "lookup"
                /\ saved' = SaveContext
                /\ UNCHANGED <<gateway, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

ReadGateway == /\ phase = "lookup"
               /\ phase' = IF gateway # "absent" /\ (ReadBeforePost \/ attempts = 1)
                            THEN "confirm" ELSE "post"
               /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

PostGateway == /\ phase = "post"
               /\ phase' = "gateway_reply"
               /\ gateway' = IF gateway = "absent" THEN "pending" ELSE gateway
               /\ unsafePost' = (unsafePost \/ ~saved)
               /\ duplicatePost' = (duplicatePost \/ gateway # "absent")
               /\ UNCHANGED <<saved, attempts, proof, unsafeAssociation>>

ReceiveGatewayReply == /\ phase = "gateway_reply"
                       /\ phase' = "confirm"
                       /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

LoseGatewayReply == /\ phase = "gateway_reply"
                    /\ phase' = "stopped"
                    /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

SettleGateway(result) == /\ gateway = "pending"
                         /\ gateway' = result
                         /\ UNCHANGED <<phase, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

ReadConfirmedProof == /\ phase = "confirm"
                      /\ AwaitProof
                      /\ (gateway = "confirmed" \/ (gateway = "mismatched" /\ ~MatchProof))
                      /\ phase' = "associate"
                      /\ proof' = (gateway = "confirmed")
                      /\ UNCHANGED <<gateway, saved, attempts, unsafePost, duplicatePost, unsafeAssociation>>

SkipProofRead == /\ phase = "confirm"
                 /\ ~AwaitProof
                 /\ phase' = "associate"
                 /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

StopWaiting == /\ phase = "confirm"
               /\ AwaitProof
               /\ (gateway \in {"pending", "failed"} \/ (gateway = "mismatched" /\ MatchProof))
               /\ phase' = "stopped"
               /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

PostAssociation == /\ phase = "associate"
                   /\ phase' = "account_reply"
                   /\ unsafeAssociation' = (unsafeAssociation \/ ~proof)
                   /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost>>

AccountAccepts == /\ phase = "account_reply"
                  /\ phase' = "verify_ownership"
                  /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

AccountUnavailable == /\ phase \in {"account_reply", "verify_ownership"}
                      /\ phase' = "stopped"
                      /\ UNCHANGED <<gateway, saved, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

VerifyOwnershipAndFinish == /\ phase = "verify_ownership"
                            /\ phase' = "complete"
                            /\ saved' = FALSE
                            /\ UNCHANGED <<gateway, attempts, proof, unsafePost, duplicatePost, unsafeAssociation>>

Done == /\ (phase = "complete" \/ (phase = "stopped" /\ attempts = 2))
        /\ UNCHANGED vars

Next == AdmitOriginalApp \/ SaveIdentity \/ ReadGateway \/ PostGateway
        \/ ReceiveGatewayReply \/ LoseGatewayReply
        \/ (\E result \in {"confirmed", "failed", "mismatched"} : SettleGateway(result))
        \/ ReadConfirmedProof \/ SkipProofRead \/ StopWaiting \/ PostAssociation
        \/ AccountAccepts \/ AccountUnavailable \/ VerifyOwnershipAndFinish \/ Done
Spec == Init /\ [][Next]_vars

ContextSavedBeforeRegistration == ~unsafePost
NoPostForVisibleRegistration == ~duplicatePost
MatchingProofBeforeAssociation == ~unsafeAssociation
====
