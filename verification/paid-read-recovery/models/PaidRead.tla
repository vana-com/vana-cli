---------------------------- MODULE PaidRead ----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Readers, Restarts, SaveBeforeSend, RefuseRejected, SerializeReads, SerializeWrites, CounterWriter
VARIABLES phase, loaded, header, snapshot, disk, pending, charged,
          crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner
vars == <<phase, loaded, header, snapshot, disk, pending, charged,
          crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
Clients == 1..Readers
Counter == IF CounterWriter THEN Readers + 1 ELSE 0
Workers == 1..(Readers + IF CounterWriter THEN 1 ELSE 0)
Empty == [nonce |-> 0, receipt |-> 0]
Init == /\ phase = [w \in Workers |-> IF w = Counter THEN "NonceRead" ELSE "Open"]
        /\ loaded = [w \in Workers |-> 0]
        /\ header = [w \in Workers |-> 0]
        /\ snapshot = [w \in Workers |-> Empty]
        /\ disk = Empty /\ pending = {} /\ charged = {}
        /\ readOwner = 0 /\ writeOwner = 0
        /\ crashes = 0 /\ unsafeSend = FALSE
        /\ reauthorized = FALSE /\ rejected = [w \in Workers |-> FALSE]
AcquireRead(w) == /\ phase[w] = "Open"
                  /\ (~SerializeReads \/ readOwner = 0)
                  /\ readOwner' = IF SerializeReads THEN w ELSE readOwner
                  /\ phase' = [phase EXCEPT ![w] = "ReadState"]
                  /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                                 crashes, unsafeSend, reauthorized, rejected, writeOwner>>
ReadBusy(w) == /\ phase[w] = "Open" /\ SerializeReads /\ readOwner # 0
               /\ phase' = [phase EXCEPT ![w] = "Busy"]
               /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                              crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
Open(w) == /\ phase[w] = "ReadState"
           /\ loaded' = [loaded EXCEPT ![w] = disk.receipt]
           /\ header' = [header EXCEPT ![w] = disk.receipt]
           /\ phase' = [phase EXCEPT ![w] = "Probe"]
           /\ UNCHANGED <<snapshot, disk, pending, charged, crashes,
                          unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
Challenge(w) == /\ phase[w] = "Probe" /\ loaded[w] = 0
                /\ phase' = [phase EXCEPT ![w] = "NonceRead"]
                /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                               crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
Replay(w) == /\ phase[w] = "Probe" /\ loaded[w] # 0
             /\ phase' = [phase EXCEPT ![w] = "Ready"]
             /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                            crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
AcquireWrite(w) == /\ phase[w] \in {"NonceRead", "ReceiptRead"}
                   /\ (~SerializeWrites \/ writeOwner = 0)
                   /\ writeOwner' = IF SerializeWrites THEN w ELSE writeOwner
                   /\ phase' = [phase EXCEPT ![w] = IF @ = "NonceRead" THEN "NonceLoad" ELSE "ReceiptLoad"]
                   /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                                  crashes, unsafeSend, reauthorized, rejected, readOwner>>
WriteBusy(w) == /\ phase[w] \in {"NonceRead", "ReceiptRead"}
                /\ SerializeWrites /\ writeOwner # 0
                /\ phase' = [phase EXCEPT ![w] = "Blocked"]
                /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                               crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
ReadNonce(w) == /\ phase[w] = "NonceLoad"
                /\ snapshot' = [snapshot EXCEPT ![w] = disk]
                /\ phase' = [phase EXCEPT ![w] = "NonceTemp"]
                /\ UNCHANGED <<loaded, header, disk, pending, charged, crashes,
                               unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
SyncNonceTemp(w) == /\ phase[w] = "NonceTemp"
                    /\ phase' = [phase EXCEPT ![w] = "NonceRename"]
                    /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                   charged, crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
CommitNonce(w) == /\ phase[w] = "NonceRename"
                  /\ disk' = [snapshot[w] EXCEPT !.nonce = @ + 1]
                  /\ header' = [header EXCEPT ![w] = snapshot[w].nonce + 1]
                  /\ phase' = [phase EXCEPT ![w] = "NonceSync"]
                  /\ UNCHANGED <<loaded, snapshot, pending, charged, crashes,
                                 unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
SyncNonceDirectory(w) == /\ phase[w] = "NonceSync"
                         /\ phase' = [phase EXCEPT ![w] = IF w = Counter THEN "Done" ELSE IF SaveBeforeSend THEN "ReceiptRead" ELSE "Ready"]
                         /\ reauthorized' = (reauthorized \/ rejected[w])
                         /\ writeOwner' = 0
                         /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                        charged, crashes, unsafeSend, rejected, readOwner>>
ReadReceipt(w) == /\ phase[w] = "ReceiptLoad"
                  /\ snapshot' = [snapshot EXCEPT ![w] = disk]
                  /\ phase' = [phase EXCEPT ![w] = "ReceiptTemp"]
                  /\ UNCHANGED <<loaded, header, disk, pending, charged,
                                 crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
SyncReceiptTemp(w) == /\ phase[w] = "ReceiptTemp"
                      /\ phase' = [phase EXCEPT ![w] = "ReceiptRename"]
                      /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                     charged, crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
CommitReceipt(w) == /\ phase[w] = "ReceiptRename"
                    /\ disk' = [snapshot[w] EXCEPT !.receipt = header[w]]
                    /\ phase' = [phase EXCEPT ![w] = "ReceiptSync"]
                    /\ UNCHANGED <<loaded, header, snapshot, pending, charged,
                                   crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
SyncReceiptDirectory(w) == /\ phase[w] = "ReceiptSync"
                           /\ phase' = [phase EXCEPT ![w] = "Ready"]
                           /\ writeOwner' = 0
                           /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                          charged, crashes, unsafeSend, reauthorized, rejected, readOwner>>
Send(w) == /\ phase[w] = "Ready"
           /\ pending' = pending \cup {header[w]}
           /\ unsafeSend' = (unsafeSend \/ disk.receipt # header[w])
           /\ phase' = [phase EXCEPT ![w] = "Waiting"]
           /\ UNCHANGED <<loaded, header, snapshot, disk, charged, crashes,
                          reauthorized, rejected, readOwner, writeOwner>>
Settle(h) == /\ h \in pending /\ charged' = charged \cup {h}
             /\ pending' = pending \ {h}
             /\ UNCHANGED <<phase, loaded, header, snapshot, disk, crashes,
                            unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
Receive(w) == /\ phase[w] = "Waiting" /\ header[w] \in charged
              /\ phase' = [phase EXCEPT ![w] = "Done"]
              /\ UNCHANGED <<loaded, header, snapshot, disk, pending, charged,
                             crashes, unsafeSend, reauthorized, rejected, readOwner, writeOwner>>
RejectSaved(w) == /\ phase[w] = "Probe" /\ loaded[w] # 0
                  /\ rejected' = [rejected EXCEPT ![w] = TRUE]
                  /\ phase' = [phase EXCEPT ![w] = IF RefuseRejected THEN "Blocked" ELSE "NonceRead"]
                  /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                 charged, crashes, unsafeSend, reauthorized, readOwner, writeOwner>>
StoreFails(w) == /\ phase[w] \in {"NonceTemp", "NonceRename", "NonceSync", "ReceiptTemp", "ReceiptRename", "ReceiptSync"}
                 /\ phase' = [phase EXCEPT ![w] = "Blocked"]
                 /\ writeOwner' = IF writeOwner = w THEN 0 ELSE writeOwner
                 /\ readOwner' = IF readOwner = w THEN 0 ELSE readOwner
                 /\ UNCHANGED <<loaded, header, snapshot, disk, pending,
                                charged, crashes, unsafeSend, reauthorized, rejected>>
CrashAndRestart(w) == /\ w \in Clients /\ crashes < Restarts /\ phase[w] # "Done"
                      /\ phase' = [phase EXCEPT ![w] = "Open"]
                      /\ loaded' = [loaded EXCEPT ![w] = 0]
                      /\ header' = [header EXCEPT ![w] = 0]
                      /\ crashes' = crashes + 1
                      /\ writeOwner' = IF writeOwner = w THEN 0 ELSE writeOwner
                      /\ readOwner' = IF readOwner = w THEN 0 ELSE readOwner
                      /\ UNCHANGED <<snapshot, disk, pending, charged,
                                     unsafeSend, reauthorized, rejected>>
ReleaseRead(w) == /\ phase[w] \in {"Done", "Blocked", "Busy"} /\ readOwner = w
                  /\ readOwner' = 0
                  /\ UNCHANGED <<phase, loaded, header, snapshot, disk, pending,
                                 charged, crashes, unsafeSend, reauthorized, rejected, writeOwner>>
Finished == /\ \A w \in Workers : phase[w] \in {"Done", "Blocked", "Busy"}
            /\ pending = {} /\ readOwner = 0 /\ writeOwner = 0 /\ UNCHANGED vars
Next == (\E w \in Workers : AcquireRead(w) \/ ReadBusy(w) \/ Open(w) \/ AcquireWrite(w) \/ WriteBusy(w) \/ ReleaseRead(w) \/ Challenge(w) \/ Replay(w) \/ ReadNonce(w)
        \/ SyncNonceTemp(w) \/ CommitNonce(w) \/ SyncNonceDirectory(w)
        \/ ReadReceipt(w) \/ SyncReceiptTemp(w) \/ CommitReceipt(w)
        \/ SyncReceiptDirectory(w) \/ Send(w) \/ Receive(w) \/ RejectSaved(w)
        \/ StoreFails(w) \/ CrashAndRestart(w)) \/ (\E h \in pending : Settle(h)) \/ Finished
Spec == Init /\ [][Next]_vars
DurableBeforeSend == ~unsafeSend
NoDuplicateCharge == Cardinality(charged) <= 1
RejectedNeverReauthorizes == ~reauthorized
=============================================================================
