---- MODULE HostedProvisioning ----

CONSTANTS RefuseProvisioningDelete, CleanupOrphanedCreate, ConditionalDelete
VARIABLES row, create, deletion, resource, listed, orphaned
vars == <<row, create, deletion, resource, listed, orphaned>>

\* orphaned is history: the create found its row already gone when the provider
\* returned. It separates that window from a delete that reads the row before the
\* handles are saved and removes it after.
Init == /\ row = "absent"
        /\ create = "idle"
        /\ deletion = "idle"
        /\ resource = FALSE
        /\ listed = FALSE
        /\ orphaned = FALSE

ReserveRow == /\ create = "idle"
              /\ create' = "reserved"
              /\ row' = "without_handles"
              /\ UNCHANGED <<deletion, resource, listed, orphaned>>

StartProvider == /\ create = "reserved"
                 /\ create' = "provisioning"
                 /\ UNCHANGED <<row, deletion, resource, listed, orphaned>>

ListRow == /\ row # "absent"
           /\ ~listed
           /\ listed' = TRUE
           /\ UNCHANGED <<row, create, deletion, resource, orphaned>>

ProviderReturns == /\ create = "provisioning"
                   /\ create' = "provider_returned"
                   /\ resource' = TRUE
                   /\ UNCHANGED <<row, deletion, listed, orphaned>>

\* updateServer returns null when the row is gone. With CleanupOrphanedCreate the
\* create deprovisions what it just made and answers 409. Without it the create
\* falls back to its stale copy and answers 201.
SaveHandles == /\ create = "provider_returned"
               /\ IF row = "absent" /\ CleanupOrphanedCreate
                  THEN /\ resource' = FALSE
                       /\ create' = "deleted_during_setup"
                       /\ UNCHANGED row
                  ELSE /\ row' = IF row = "absent" THEN "absent" ELSE "with_handles"
                       /\ create' = "handles_written"
                       /\ UNCHANGED resource
               /\ orphaned' = (orphaned \/ row = "absent")
               /\ UNCHANGED <<deletion, listed>>

ReturnCreated == /\ create = "handles_written"
                 /\ create' = "created"
                 /\ UNCHANGED <<row, deletion, resource, listed, orphaned>>

ObserveRunning == /\ row = "with_handles"
                  /\ row' = "running"
                  /\ UNCHANGED <<create, deletion, resource, listed, orphaned>>

ReadDeleteRow == /\ listed
                 /\ row # "absent"
                 /\ deletion = "idle"
                 /\ deletion' = IF RefuseProvisioningDelete /\ row # "running" THEN "refused"
                                ELSE IF row = "without_handles" THEN "skip_cleanup"
                                ELSE "cleaning"
                 /\ UNCHANGED <<row, create, resource, listed, orphaned>>

ProviderCleanup == /\ deletion = "cleaning"
                   /\ resource' = FALSE
                   /\ deletion' = "cleanup_done"
                   /\ UNCHANGED <<row, create, listed, orphaned>>

\* A delete that skipped cleanup removes the row. With ConditionalDelete the
\* write only matches a row that still has no handles.
DeleteRow == /\ \/ deletion = "cleanup_done"
                \/ /\ deletion = "skip_cleanup"
                   /\ (~ConditionalDelete \/ row = "without_handles")
             /\ row' = "absent"
             /\ deletion' = "deleted"
             /\ UNCHANGED <<create, resource, listed, orphaned>>

\* The conditional delete matched nothing because handles were saved after the
\* read. The route reads the row once more and cleans up what it now has.
RereadAfterLostRace == /\ ConditionalDelete
                       /\ deletion = "skip_cleanup"
                       /\ row \notin {"without_handles", "absent"}
                       /\ deletion' = "cleaning"
                       /\ UNCHANGED <<row, create, resource, listed, orphaned>>

Done == /\ create \in {"created", "deleted_during_setup"}
        /\ UNCHANGED vars

Next == ReserveRow \/ StartProvider \/ ListRow \/ ProviderReturns \/ SaveHandles
        \/ ReturnCreated \/ ObserveRunning \/ ReadDeleteRow \/ RereadAfterLostRace \/ ProviderCleanup \/ DeleteRow \/ Done
Spec == Init /\ [][Next]_vars

\* The whole property: a successful create never leaves a resource with no row.
CreatedResourceHasTrackingRow == ~(create = "created" /\ resource /\ row = "absent")

\* The part the create route owns: a create that found its row gone never reports success.
CreateNeverSucceedsWithoutRow == ~(orphaned /\ create \in {"handles_written", "created"})
====
