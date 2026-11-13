---- MODULE HostedProvisioning ----

CONSTANT RefuseProvisioningDelete
VARIABLES row, create, deletion, resource, listed
vars == <<row, create, deletion, resource, listed>>

Init == /\ row = "absent"
        /\ create = "idle"
        /\ deletion = "idle"
        /\ resource = FALSE
        /\ listed = FALSE

ReserveRow == /\ create = "idle"
              /\ create' = "reserved"
              /\ row' = "without_handles"
              /\ UNCHANGED <<deletion, resource, listed>>

StartProvider == /\ create = "reserved"
                 /\ create' = "provisioning"
                 /\ UNCHANGED <<row, deletion, resource, listed>>

ListRow == /\ row # "absent"
           /\ ~listed
           /\ listed' = TRUE
           /\ UNCHANGED <<row, create, deletion, resource>>

ProviderReturns == /\ create = "provisioning"
                   /\ create' = "provider_returned"
                   /\ resource' = TRUE
                   /\ UNCHANGED <<row, deletion, listed>>

SaveHandles == /\ create = "provider_returned"
               /\ row' = IF row = "absent" THEN "absent" ELSE "with_handles"
               /\ create' = "handles_written"
               /\ UNCHANGED <<deletion, resource, listed>>

ReturnCreated == /\ create = "handles_written"
                 /\ create' = "created"
                 /\ UNCHANGED <<row, deletion, resource, listed>>

ObserveRunning == /\ row = "with_handles"
                  /\ row' = "running"
                  /\ UNCHANGED <<create, deletion, resource, listed>>

ReadDeleteRow == /\ listed
                 /\ row # "absent"
                 /\ deletion = "idle"
                 /\ deletion' = IF RefuseProvisioningDelete /\ row # "running" THEN "refused"
                                ELSE IF row = "without_handles" THEN "skip_cleanup"
                                ELSE "cleaning"
                 /\ UNCHANGED <<row, create, resource, listed>>

ProviderCleanup == /\ deletion = "cleaning"
                   /\ resource' = FALSE
                   /\ deletion' = "cleanup_done"
                   /\ UNCHANGED <<row, create, listed>>

DeleteRow == /\ deletion \in {"skip_cleanup", "cleanup_done"}
             /\ row' = "absent"
             /\ deletion' = "deleted"
             /\ UNCHANGED <<create, resource, listed>>

Done == /\ create = "created"
        /\ UNCHANGED vars

Next == ReserveRow \/ StartProvider \/ ListRow \/ ProviderReturns \/ SaveHandles
        \/ ReturnCreated \/ ObserveRunning \/ ReadDeleteRow \/ ProviderCleanup \/ DeleteRow \/ Done
Spec == Init /\ [][Next]_vars

CreatedResourceHasTrackingRow == ~(create = "created" /\ resource /\ row = "absent")
====
