export const title = "Promote an existing app from Moksha to mainnet";

export function state(values) {
  if (values.unsafePost) return "Submitted without a recovery journal";
  if (values.duplicatePost) return "Sent another registration";
  if (values.unsafeAssociation)
    return "Asked Account before matching confirmation";
  return {
    idle: "Ready to promote an owned app",
    admitted: "App and Account verified",
    lookup: values.saved
      ? "Recovery context ready"
      : "Recovery context missing",
    post:
      values.gateway === "absent"
        ? "Mainnet record absent"
        : "Visible registration bypassed",
    gateway_reply: "Registration submitted",
    confirm: "Waiting for mainnet confirmation",
    associate: "Account association ready",
    account_reply: "Waiting for Account association",
    verify_ownership: "Verifying Account ownership",
    stopped: values.saved
      ? "Stopped with recovery context"
      : "Stopped without recovery context",
    complete: "App ready on mainnet",
  }[values.phase];
}

export function step(action, from, to) {
  if (action === "AdmitOriginalApp") {
    return from.phase === "stopped"
      ? "resume the original app"
      : "choose app and production URL";
  }
  if (action === "ReadGateway") {
    if (to.phase === "post") {
      return from.gateway === "absent"
        ? "no registration found"
        : "ignore the visible registration";
    }
    return "use the visible registration";
  }
  if (action === "StopWaiting") {
    return from.gateway === "pending"
      ? "confirmation times out"
      : "proof fails or names another app";
  }
  if (action === "ReadConfirmedProof") {
    return from.gateway === "confirmed"
      ? "matching confirmed proof arrives"
      : "accept proof for a different owner";
  }
  return {
    SaveIdentity: to.saved
      ? "save recovery context"
      : "skip saving recovery context",
    PostGateway: "submit to the gateway",
    ReceiveGatewayReply: "registration reply arrives",
    LoseGatewayReply: "registration reply is lost",
    SettleGateway: "mainnet proof settles",
    SkipProofRead: "skip the confirmation read",
    PostAssociation: "ask Account to associate the app",
    AccountAccepts: "Account accepts the association",
    AccountUnavailable: "Account association or ownership is unconfirmed",
    VerifyOwnershipAndFinish: "Account confirms ownership",
    Done: "finish",
  }[action];
}
