import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { readPersonalServerData } from "@opendatalabs/vana-sdk/direct/personal-server-read";
import { runAppRead } from "../../src/cli/app/read.js";
import { createReceiptsStore } from "../../src/core/receipts.js";
import { createRequestsStore } from "../../src/core/requests-store.js";

const [root, stage] = process.argv.slice(2);
const key =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(key);
const grant = `0x${"1".repeat(64)}`;
const scope = "github.repos";
const file = path.join(root, "receipts.json");
const ledgerFile = path.join(root, "fixture-ledger.json");
const receipts = createReceiptsStore(file);
let inReceipt = false;
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (inReceipt && stage === "before-receipt-rename" && args[1] === file)
    process.exit(86);
  return Reflect.apply(rename, fs, args);
};
const writeLedger = (ledger) =>
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
const loadLedger = () =>
  fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
    : { sent: [], pending: [], settled: [] };
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://fixture.invalid/"))
    throw new Error("External I/O disabled");
  const header = new Headers(init?.headers).get("X-PAYMENT");
  if (!header)
    return Response.json({ grantId: grant, amount: "1" }, { status: 402 });
  const identity = createHash("sha256").update(header).digest("hex");
  const ledger = loadLedger();
  ledger.sent.push(identity);
  ledger.pending = [...new Set([...ledger.pending, identity])];
  writeLedger(ledger);
  if (stage === "after-send") process.exit(86);
  if (stage === "hold-read") {
    process.send?.("payment-pending");
    await new Promise(() => {});
  }
  ledger.settled = [...new Set([...ledger.settled, ...ledger.pending])];
  ledger.pending = [];
  writeLedger(ledger);
  if (stage === "after-settlement") process.exit(86);
  return Response.json({ rows: ["synthetic"] });
};
process.env.VANA_ENV = "dev";
const exit = await runAppRead(
  scope,
  {
    json: true,
    grant,
    network: "moksha",
    server: "https://fixture.invalid",
    pay: true,
  },
  {
    resolveKey: () => ({
      privateKey: key,
      address: account.address,
      publicKey: account.publicKey,
      source: "env",
    }),
    createClient: () => ({
      getGrant: async () => ({
        id: grant,
        grantorAddress: `0x${"2".repeat(40)}`,
        scopes: [scope],
        status: "active",
        expiresAt: null,
      }),
    }),
    requests: createRequestsStore(path.join(root, "requests.json")),
    receipts: {
      ...receipts,
      nextNonce(payer) {
        const n = receipts.nextNonce(payer);
        if (stage === "after-nonce") process.exit(86);
        return n;
      },
      saveReceipt(k, receipt) {
        inReceipt = true;
        receipts.saveReceipt(k, receipt);
        inReceipt = false;
        if (stage === "after-receipt") process.exit(86);
      },
    },
    read: (params) =>
      readPersonalServerData({ ...params, transportRetry: { attempts: 1 } }),
  },
);
process.exitCode = exit;
