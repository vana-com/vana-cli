export const title = "Collect data and preserve the latest accepted export";

export function state(values) {
  if (values.visibleGeneration !== values.receipt) {
    return "An old response replaces the accepted result";
  }
  if (values.foreignReplacement) {
    return "Another account replaces the pending export";
  }
  if (values.receipt === "none") {
    return "Collectors running without an accepted export";
  }
  if (Object.values(values.stage).includes("superseded")) {
    return "Older response discarded. Newer export retained";
  }
  if (Object.values(values.stage).includes("refused")) {
    return "Other account's export stays local";
  }
  if (values.visibleStatus === "stored") {
    return "Accepted export stored";
  }
  if (values.visibleStatus === "failed") {
    return "Accepted export remains local after an upload failure";
  }
  if (values.stage[values.receipt] === "uploading") {
    return "Accepted export local. Upload pending";
  }
  return "Accepted export recorded locally";
}

export function step(action, from, to) {
  if (action === "PublishReceipt" && from.receipt !== "none") {
    return to.foreignReplacement
      ? "Accept the other account's export"
      : "Accept the newer export";
  }
  const changed = Object.keys(from.stage).find(
    (id) => from.stage[id] !== to.stage[id],
  );
  if (changed && changed !== from.receipt) {
    if (action === "StartUpload") return "Older export starts uploading";
    if (action === "ReceiveUploadResult") return "Older upload reports back";
    if (action === "SettleResult") return "Apply the older upload result";
  }
  return {
    CompleteCollection: "A connector finishes collecting",
    PublishReceipt: "Record the local export",
    RefusePublication: "Refuse to replace another account's export",
    StartUpload: "Upload to Personal Server",
    ReceiveUploadResult: "Personal Server responds",
    SettleResult: "Record the upload result",
    RejectStaleResult: "Discard settlement for the older export",
    Done: "Finish",
  }[action];
}
