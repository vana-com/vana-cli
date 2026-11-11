export const title = "Prepare to collect into a Personal Server";

export function state(v) {
  if (v.target === "foreign" && v.probed && !v.consent) {
    return "CLI probes a foreign server without permission";
  }
  if (v.phase === "ready" && v.ownerChanged) {
    return "Collection is admitted for the previous account";
  }
  if (
    ["checking", "rechecking", "verify"].includes(v.phase) &&
    v.ownerChanged
  ) {
    return "Account changed during the access check";
  }
  return {
    session: "Checking the Vana account",
    "sign-in": "Sign in to Vana",
    detect: "Finding a Personal Server",
    prepare: "Preparing a Personal Server",
    redetect: "Finding a Personal Server",
    foreign: "Server belongs to another account",
    probe: "Checking server access",
    checking: "Checking server access",
    approve: "Approve this CLI",
    reprobe: "Checking server access",
    rechecking: "Checking server access",
    verify: "Server access confirmed",
    refused: "Collection blocked",
    ready: "Ready to collect",
  }[v.phase];
}

export function step(action, from, to) {
  switch (action) {
    case "ReadSession":
      if (to.phase === "detect") return "Account identified";
      if (to.phase === "sign-in") return "Sign-in required";
      return "No usable account";
    case "SignIn":
      return to.phase === "detect" ? "Sign-in succeeds" : "Sign-in fails";
    case "DetectServer":
      if (to.phase === "prepare") return "No server found";
      if (to.phase === "foreign") return "Found another owner's server";
      if (to.phase === "probe") return "Found your server";
      return "No usable server";
    case "PrepareServer":
      return "Try to find the prepared server";
    case "DecideForeignConsent":
      if (to.phase === "refused") return "Permission missing";
      return to.consent
        ? "Person allows this server"
        : "CLI proceeds without permission";
    case "StartProbe":
      return "Send access check";
    case "ProbeReturns":
      if (to.phase === "verify") return "Server accepts the CLI";
      if (to.phase === "approve") return "Approval required";
      return "Access unavailable";
    case "ApproveServer":
      return to.phase === "reprobe" ? "Person approves" : "Approval fails";
    case "AccountChanges":
      return "Account changes";
    case "VerifyOwner":
      return to.phase === "ready"
        ? "Admit collection"
        : "Retry with intended account";
    case "Done":
      return "Finish";
  }
}
