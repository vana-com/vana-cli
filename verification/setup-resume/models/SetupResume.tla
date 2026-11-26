------------------------- MODULE SetupResume -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Clients, Resumes, Crashes, ClaimRequired, ExistingBalance,
          ContextMatches, PersistIntent, StableFundingKey, StableConsentKey,
          KnownIdsReadOnly, RequireReady, CheckContext, MonotonicFunding
VARIABLE state
Workers == 1..Clients
Ready == {"funded", "not_needed"}
TerminalFunding == {"funded", "not_needed", "failed"}
InitialClient == [pc |-> "Fresh", fk |-> 0, ck |-> 0, fo |-> 0, fs |-> "none",
                 ci |-> 0, reply |-> "none", remote |-> 0, resumes |-> 0,
                 resuming |-> FALSE, writeFs |-> "none", writeFo |-> 0]
Init == state = [saved |-> FALSE, fk |-> 0, ck |-> 0, fo |-> 0,
                 fs |-> "none", ci |-> 0, writer |-> 0,
                 clients |-> [w \in Workers |-> InitialClient],
                 fundOps |-> {}, consentOps |-> {}, funded |-> FALSE, failed |-> FALSE,
                 claimed |-> ~ClaimRequired, decision |-> "pending",
                 existingReady |-> FALSE, crashes |-> 0,
                 unsafeDurability |-> FALSE, unsafeContext |-> FALSE,
                 unsafeKnown |-> FALSE, unsafeReady |-> FALSE,
                 regressed |-> FALSE]
CtxBad(w) == state.clients[w].resuming /\ ~ContextMatches
FundingKey(w) == state.clients[w].fk + IF StableFundingKey THEN 0 ELSE state.clients[w].resumes
ConsentKey(w) == state.clients[w].ck + IF StableConsentKey THEN 0 ELSE state.clients[w].resumes
Fresh(w) == /\ state.clients[w].pc = "Fresh"
            /\ state' = [state EXCEPT !.clients[w].pc = IF state.saved THEN "Stopped" ELSE "SaveBegin"]
BeginSave(w) == /\ state.clients[w].pc = "SaveBegin" /\ state.writer = 0
                /\ state' = [state EXCEPT !.writer = w, !.clients[w].pc = "SaveCheck"]
CheckSave(w) == /\ state.clients[w].pc = "SaveCheck"
                /\ state' = IF state.saved
                  THEN [state EXCEPT !.writer = 0, !.clients[w].pc = "Stopped"]
                  ELSE [state EXCEPT !.clients[w].pc = "SaveTemp", !.clients[w].fk = w, !.clients[w].ck = w]
SaveTemp(w) == /\ state.clients[w].pc = "SaveTemp"
               /\ state' = [state EXCEPT !.clients[w].pc = "SaveCommit"]
SaveCommit(w) == /\ state.clients[w].pc = "SaveCommit"
                 /\ state' = IF PersistIntent
                    THEN [state EXCEPT !.saved = TRUE, !.fk = w, !.ck = w, !.clients[w].pc = "SaveRelease"]
                    ELSE [state EXCEPT !.clients[w].pc = "SaveRelease"]
SaveRelease(w) == /\ state.clients[w].pc = "SaveRelease"
                  /\ state' = [state EXCEPT !.writer = 0, !.clients[w].pc = "Funding"]
Resume(w) == /\ state.clients[w].pc \in {"Stopped", "Human", "AwaitApproval"}
             /\ state.saved /\ state.clients[w].resumes < Resumes
             /\ state' = [state EXCEPT !.clients[w].pc = "Load", !.clients[w].resuming = TRUE,
                          !.clients[w].resumes = @ + 1]
Load(w) == /\ state.clients[w].pc = "Load"
           /\ state' = IF CheckContext /\ CtxBad(w)
              THEN [state EXCEPT !.clients[w].pc = "Rejected"]
              ELSE [state EXCEPT !.clients[w].fk = state.fk, !.clients[w].ck = state.ck,
                                !.clients[w].fo = state.fo, !.clients[w].fs = state.fs,
                                !.clients[w].ci = state.ci, !.clients[w].pc = "Funding"]
SkipReady(w) == /\ state.clients[w].pc = "Funding" /\ state.clients[w].fs \in Ready
                /\ state' = [state EXCEPT !.clients[w].pc = "Consent"]
StopFailed(w) == /\ state.clients[w].pc = "Funding" /\ state.clients[w].fs = "failed"
                 /\ state' = [state EXCEPT !.clients[w].pc = "Stopped"]
FundPost(w) == /\ state.clients[w].pc = "Funding" /\ state.clients[w].fs \notin TerminalFunding
               /\ (state.clients[w].fo = 0 \/ ~KnownIdsReadOnly)
               /\ state' = [state EXCEPT
                    !.unsafeDurability = (@ \/ ~state.saved),
                    !.unsafeKnown = (@ \/ state.clients[w].fo # 0),
                    !.unsafeContext = (@ \/ CtxBad(w)),
                    !.fundOps = IF state.claimed /\ ~ExistingBalance THEN @ \cup {FundingKey(w)} ELSE @,
                    !.clients[w].remote = IF ExistingBalance THEN 0 ELSE FundingKey(w),
                    !.clients[w].reply = IF ~state.claimed THEN "claim"
                       ELSE IF ExistingBalance THEN IF state.existingReady THEN "not_needed" ELSE "pending"
                       ELSE IF state.failed THEN "failed" ELSE IF state.funded THEN "funded" ELSE "pending",
                    !.clients[w].pc = "FundReply"]
FundGet(w) == /\ state.clients[w].pc = "Funding" /\ state.clients[w].fs \notin TerminalFunding
              /\ state.clients[w].fo # 0 /\ KnownIdsReadOnly
              /\ state' = [state EXCEPT !.unsafeContext = (@ \/ CtxBad(w)),
                   !.clients[w].remote = state.clients[w].fo,
                   !.clients[w].reply = IF state.failed THEN "failed" ELSE IF state.funded THEN "funded" ELSE "pending",
                   !.clients[w].pc = "FundReply"]
Claim(w) == /\ state.clients[w].pc = "FundReply" /\ state.clients[w].reply = "claim"
            /\ state' = [state EXCEPT !.clients[w].pc = IF RequireReady THEN "Human" ELSE "Consent"]
AcceptFunding(w) == /\ state.clients[w].pc = "FundReply" /\ state.clients[w].reply # "claim"
                    /\ state' = [state EXCEPT !.clients[w].pc = "FundSaveBegin"]
BeginFundSave(w) == /\ state.clients[w].pc = "FundSaveBegin" /\ state.writer = 0
                    /\ state' = [state EXCEPT !.writer = w, !.clients[w].pc = "FundSaveRead"]
ReadFundSave(w) == /\ state.clients[w].pc = "FundSaveRead"
                   /\ state' = IF state.fo # 0 /\ state.fo # state.clients[w].remote
                      THEN [state EXCEPT !.writer = 0, !.clients[w].pc = "Stopped"]
                      ELSE IF MonotonicFunding /\ state.fs \in TerminalFunding
                        THEN [state EXCEPT !.clients[w].pc = "FundRetainRelease"]
                      ELSE [state EXCEPT
                        !.clients[w].writeFo = state.clients[w].remote,
                        !.clients[w].writeFs = state.clients[w].reply,
                        !.clients[w].pc = "FundSaveCommit"]
CommitFundSave(w) == /\ state.clients[w].pc = "FundSaveCommit"
                     /\ state' = [state EXCEPT
                          !.regressed = (@ \/ (state.fs \in TerminalFunding /\ state.clients[w].writeFs \notin TerminalFunding)),
                          !.fs = state.clients[w].writeFs, !.fo = state.clients[w].writeFo,
                          !.clients[w].fs = state.clients[w].writeFs,
                          !.clients[w].fo = state.clients[w].writeFo,
                          !.clients[w].pc = "FundSaveRelease"]
ReleaseRetainedFunding(w) == /\ state.clients[w].pc = "FundRetainRelease"
                            /\ state' = [state EXCEPT !.writer = 0,
                                 !.clients[w].fs = state.fs, !.clients[w].fo = state.fo,
                                 !.clients[w].pc = IF state.fs \in Ready THEN "Consent" ELSE "Stopped"]
JournalBusy(w) == /\ state.clients[w].pc \in {"SaveBegin", "FundSaveBegin", "ConsentReply"}
                  /\ state.writer # 0
                  /\ state' = [state EXCEPT !.clients[w].pc = "Stopped"]
ReleaseFundSave(w) == /\ state.clients[w].pc = "FundSaveRelease"
                      /\ state' = [state EXCEPT !.writer = 0,
                           !.clients[w].pc = IF state.clients[w].fs \in Ready \/ ~RequireReady THEN "Consent" ELSE "Stopped"]
ConsentPost(w) == /\ state.clients[w].pc = "Consent" /\ state.clients[w].ci = 0
                  /\ state' = [state EXCEPT
                       !.unsafeDurability = (@ \/ ~state.saved),
                       !.unsafeContext = (@ \/ CtxBad(w)),
                       !.unsafeReady = (@ \/ state.clients[w].fs \notin Ready),
                       !.consentOps = @ \cup {ConsentKey(w)},
                       !.clients[w].remote = ConsentKey(w), !.clients[w].pc = "ConsentReply"]
ConsentGet(w) == /\ state.clients[w].pc = "Consent" /\ state.clients[w].ci # 0
                 /\ state' = [state EXCEPT !.unsafeContext = (@ \/ CtxBad(w)), !.clients[w].pc = "CheckApproval"]
BeginConsentSave(w) == /\ state.clients[w].pc = "ConsentReply" /\ state.writer = 0
                       /\ state' = [state EXCEPT !.writer = w, !.clients[w].pc = "ConsentSaveRead"]
ReadConsentSave(w) == /\ state.clients[w].pc = "ConsentSaveRead"
                      /\ state' = IF state.ci # 0 /\ state.ci # state.clients[w].remote
                         THEN [state EXCEPT !.writer = 0, !.clients[w].pc = "Stopped"]
                         ELSE [state EXCEPT !.clients[w].pc = "ConsentSaveCommit"]
CommitConsentSave(w) == /\ state.clients[w].pc = "ConsentSaveCommit"
                        /\ state' = [state EXCEPT !.ci = state.clients[w].remote,
                             !.clients[w].ci = state.clients[w].remote, !.clients[w].pc = "ConsentSaveRelease"]
ReleaseConsentSave(w) == /\ state.clients[w].pc = "ConsentSaveRelease"
                         /\ state' = [state EXCEPT !.writer = 0, !.clients[w].pc = "CheckApproval"]
CheckApproval(w) == /\ state.clients[w].pc = "CheckApproval"
                    /\ state' = [state EXCEPT !.clients[w].pc = IF state.decision = "pending" THEN "AwaitApproval"
                         ELSE IF state.decision = "approved" THEN "Done" ELSE "Refused"]
LoseResponse(w) == /\ state.clients[w].pc \in {"FundReply", "ConsentReply"}
                   /\ state' = [state EXCEPT !.clients[w].pc = "Stopped"]
Crash(w) == /\ state.crashes < Crashes /\ state.clients[w].pc \notin {"Done", "Refused", "Rejected"}
            /\ state' = [state EXCEPT !.crashes = @ + 1, !.clients[w].pc = "Stopped",
                 !.writer = IF @ = w THEN 0 ELSE @]
HumanClaims == /\ ~state.claimed /\ state.saved /\ state' = [state EXCEPT !.claimed = TRUE]
CreditReady == /\ state.fundOps # {} /\ ~state.funded /\ ~state.failed /\ state' = [state EXCEPT !.funded = TRUE]
CreditFails == /\ state.fundOps # {} /\ ~state.funded /\ ~state.failed /\ state' = [state EXCEPT !.failed = TRUE]
ExistingReady == /\ ExistingBalance /\ ~state.existingReady /\ state.saved
                 /\ state' = [state EXCEPT !.existingReady = TRUE]
HumanDecides == /\ state.consentOps # {} /\ state.decision = "pending"
                /\ \E decision \in {"approved", "denied", "expired"} : state' = [state EXCEPT !.decision = decision]
Finished == /\ \A w \in Workers : state.clients[w].pc \in {"Done", "Refused", "Rejected", "Stopped", "Human", "AwaitApproval"}
            /\ state.writer = 0 /\ UNCHANGED state
Next == (\E w \in Workers : Fresh(w) \/ BeginSave(w) \/ CheckSave(w) \/ SaveTemp(w)
        \/ SaveCommit(w) \/ SaveRelease(w) \/ Resume(w) \/ Load(w) \/ SkipReady(w)
        \/ StopFailed(w) \/ FundPost(w) \/ FundGet(w) \/ Claim(w) \/ AcceptFunding(w)
        \/ JournalBusy(w) \/ ReleaseRetainedFunding(w) \/ BeginFundSave(w) \/ ReadFundSave(w) \/ CommitFundSave(w) \/ ReleaseFundSave(w)
        \/ ConsentPost(w) \/ ConsentGet(w) \/ BeginConsentSave(w) \/ ReadConsentSave(w)
        \/ CommitConsentSave(w) \/ ReleaseConsentSave(w) \/ CheckApproval(w)
        \/ LoseResponse(w) \/ Crash(w)) \/ HumanClaims \/ CreditReady \/ CreditFails \/ ExistingReady \/ HumanDecides \/ Finished
Spec == Init /\ [][Next]_state
DurableBeforePost == ~state.unsafeDurability
OneFundingOperation == Cardinality(state.fundOps) <= 1
OneConsentRequest == Cardinality(state.consentOps) <= 1
ConsentNeedsReadyCredit == ~state.unsafeReady
ChangedResumeRejected == ~state.unsafeContext
KnownFundingIsGetOnly == ~state.unsafeKnown
TerminalFundingRetained == ~state.regressed
=============================================================================
