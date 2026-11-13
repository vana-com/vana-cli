import { state as overview, step, title } from "./overview.mjs";
export { step, title };

const phases = {
  Fresh: "new command",
  SaveBegin: "waiting to save setup",
  SaveCheck: "checking unfinished setups under lock",
  SaveTemp: "preparing temporary journal",
  SaveCommit: "ready to rename setup journal",
  SaveRelease: "setup publication finished; release lock next",
  Load: "validating resume context",
  Funding: "ready to inspect funding",
  FundReply: "funding response received",
  FundSaveBegin: "waiting to save funding",
  FundSaveRead: "reading current funding under lock",
  FundSaveCommit: "ready to publish selected funding result",
  FundSaveRelease: "funding publication finished; release lock next",
  FundRetainRelease: "terminal funding retained; release lock next",
  Consent: "ready to recover consent",
  ConsentReply: "consent accepted remotely",
  ConsentSaveRead: "checking consent identity under lock",
  ConsentSaveCommit: "ready to publish consent identity",
  ConsentSaveRelease: "consent publication finished; release lock next",
  CheckApproval: "checking approval",
  Stopped: "stopped",
  Human: "waiting for claim",
  AwaitApproval: "waiting for approval",
  Done: "approval received",
  Refused: "denied or expired",
  Rejected: "changed context rejected",
};

// Counterexamples retain each command's phase and the journal/service changes.
// In particular, a second command must remain visible during a stale write.
export function state(v) {
  const s = v.state;
  const commands = Object.entries(s.clients).map(
    ([id, c]) =>
      `Command ${id}: ${phases[c.pc]}; cached funding ${c.fs}; reply ${c.reply}; selected write ${c.writeFs}; resume ${c.resumes}`,
  );
  return [
    overview(v),
    ...commands,
    `Journal: ${s.saved ? "setup saved" : "setup absent"}, funding ${s.fs}, operation ${s.fo || "unknown"}, consent ${s.ci || "unknown"}, writer ${s.writer || "none"}`,
    `Service: ${s.claimed ? "claimed" : "unclaimed"}, credit ${s.failed ? "failed" : s.funded || s.existingReady ? "usable" : "pending"}, approval ${s.decision}, funding keys ${s.fundOps.join(",") || "none"}, consent keys ${s.consentOps.join(",") || "none"}, exits ${s.crashes}`,
  ].join(" | ");
}
