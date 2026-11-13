export const title = "Paid-read recovery: one reader and overlapping readers";
export const state = (v) => {
  const broken = [
    v.unsafeSend && "Saved receipt erased",
    v.charged.length > 1 && "Two fees possible",
    v.reauthorized && "Rejected receipt replaced",
  ]
    .filter(Boolean)
    .join(" + ");
  if (Object.keys(v.phase).length > 1) {
    if (v.phase[1] === "Busy" || v.phase[2] === "Busy")
      return "Overlapping read stopped; retry reloads receipt";
    if (v.unsafeSend || v.charged.length > 1 || v.reauthorized) return broken;
    if (v.charged.length)
      return "One payment settled; recovery receipt retained";
    if (Object.values(v.phase).includes("Waiting"))
      return "One payment sent; receipt retained";
    if (v.disk.receipt) return "Payment receipt saved";
    if (v.writeOwner) return "One writer updating payment state";
    if (v.readOwner) return "One reader holds the payment decision";
    return "Readers ready; payment locks available";
  }
  const labels = {
    Open: "Start or restart",
    ReadState: "Read lock held; loading saved receipt",
    Busy: "Read already running; retry later",
    NonceLoad: "Preparing payment",
    ReceiptLoad: "Saving recovery receipt",
    Probe: v.loaded[1]
      ? "Retrying saved payment"
      : "Checking whether payment is needed",
    NonceRead: "Preparing payment",
    NonceTemp: "Preparing payment",
    NonceRename: "Preparing payment",
    NonceSync: "Preparing payment",
    ReceiptRead: "Saving recovery receipt",
    ReceiptTemp: "Saving recovery receipt",
    ReceiptRename: "Saving recovery receipt",
    ReceiptSync: "Saving recovery receipt",
    Ready: "Ready to send",
    Waiting: v.charged.length ? "Charged; waiting for data" : "Payment sent",
    Done: "Data received",
    Blocked: "Stopped for repair",
  };
  return `${broken ? broken + ": " : ""}${labels[v.phase[1]]}`;
};
export const step = (action, from, to) => {
  if (action === "AcquireRead") return "you reserve this read intent";
  if (action === "ReadBusy") return "another read returns not ready";
  if (action === "WriteBusy") return "a competing write returns not ready";
  if (action === "AcquireWrite") return "you reserve the payment state file";
  if (action === "ReleaseRead") return "you release the read intent";
  if (action === "SyncNonceDirectory")
    return "you finish preparing the payment";
  if (action === "SyncReceiptDirectory") return "the recovery receipt is saved";
  if (action === "CommitNonce")
    return from.disk.receipt !== to.disk.receipt
      ? "a stale counter write erases the saved receipt"
      : "the payment counter is committed";
  if (action === "CommitReceipt") return "the payment receipt is committed";
  if (action === "Send") return "you send the signed payment";
  if (from.charged.length !== to.charged.length)
    return "the fixture settles a distinct payment";
  return (
    {
      Open: "you open the saved payment state",
      Challenge: "the server requests payment",
      Replay: "you reuse the same saved header",
      Receive: "the data arrives",
      RejectSaved: "the server rejects the saved receipt",
      StoreFails: "saving payment state fails",
      CrashAndRestart: "the CLI closes and you restart",
      ReadNonce: "you start preparing a new payment",
    }[action] ?? "you continue the local write"
  );
};
