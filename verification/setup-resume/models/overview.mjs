export const title =
  "Setup resumes with the saved funding and consent identities";

export function state({ state: s }) {
  const c = s.clients[1];
  let label;
  if (c.pc === "Fresh") label = "New setup";
  else if (c.pc.startsWith("Save")) label = "Saving setup identity";
  else if (c.pc === "Load") label = "Checking resume context";
  else if (c.pc === "Funding")
    label =
      c.fs === "failed"
        ? "Funding failed"
        : ["funded", "not_needed"].includes(c.fs)
          ? "Credit ready"
          : c.fo
            ? "Inspecting saved funding"
            : "Requesting funding with saved key";
  else if (c.pc === "FundReply")
    label = {
      claim: "Claim required",
      pending: "Funding pending",
      funded: "Usable credit confirmed",
      not_needed: "Existing credit usable",
      failed: "Funding failed",
    }[c.reply];
  else if (c.pc.startsWith("FundSave") || c.pc === "FundRetainRelease")
    label = "Saving funding result";
  else if (c.pc === "Consent")
    label = c.ci
      ? "Inspecting saved consent"
      : "Creating consent with saved key";
  else if (c.pc === "ConsentReply") label = "Consent accepted remotely";
  else if (c.pc.startsWith("ConsentSave")) label = "Saving consent identity";
  else
    label =
      {
        Stopped: s.saved
          ? "Setup saved for resume"
          : "Stopped before setup was saved",
        Human: "Waiting for a person to claim",
        AwaitApproval: "Waiting for approval",
        CheckApproval: "Checking approval",
        Done: "Approval received",
        Refused: "Denied or expired",
        Rejected: "Changed context rejected",
      }[c.pc] ?? c.pc;
  const failures = [];
  if (s.unsafeDurability) failures.push("sent before saving");
  if (s.fundOps.length > 1) failures.push("second funding operation");
  if (s.consentOps.length > 1) failures.push("second consent request");
  if (s.unsafeKnown) failures.push("POST despite known funding ID");
  if (s.unsafeReady) failures.push("consent before usable credit");
  if (s.unsafeContext) failures.push("changed resume transmitted");
  if (s.regressed) failures.push("terminal funding overwritten");
  return failures.length ? `${label}: ${failures.join(", ")}` : label;
}

export const step = (action) =>
  ({
    JournalBusy: "leave setup resumable while another command writes",
    ReleaseRetainedFunding: "retain terminal funding and release the journal",
    Fresh: "start setup",
    BeginSave: "take journal writer lock",
    CheckSave: "check for an unfinished setup",
    SaveTemp: "write and sync temporary journal",
    SaveCommit: "atomically publish setup identity",
    SaveRelease: "release journal writer lock",
    Resume: "run saved resume command",
    Load: "validate saved identity and options",
    SkipReady: "reuse saved usable credit",
    StopFailed: "retain failure for inspection",
    FundPost: "send the saved funding key",
    FundGet: "GET the saved operation",
    Claim: "show claim handoff",
    AcceptFunding: "accept funding response",
    BeginFundSave: "take journal writer lock",
    ReadFundSave: "read current funding under lock",
    CommitFundSave: "atomically publish funding result",
    ReleaseFundSave: "release journal writer lock",
    ConsentPost: "send the saved consent payload",
    ConsentGet: "GET the saved request",
    BeginConsentSave: "take journal writer lock",
    ReadConsentSave: "check the saved request identity",
    CommitConsentSave: "atomically publish consent identity",
    ReleaseConsentSave: "release journal writer lock",
    CheckApproval: "read approval result",
    LoseResponse: "lose the response after remote acceptance",
    Crash: "process exits before the next step",
    HumanClaims: "person completes claim",
    CreditReady: "service confirms usable credit",
    CreditFails: "service reports funding failure",
    ExistingReady: "existing deposit becomes usable",
    HumanDecides: "person approves or refuses",
    Finished: "wait for another invocation",
  })[action] ?? action;
