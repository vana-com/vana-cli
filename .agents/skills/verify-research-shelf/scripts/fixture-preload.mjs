import { appendFile, readFile, readdir, mkdir, rename } from "node:fs/promises";

const stateFile = process.env.SHELF_VERIFY_STATE;
const eventFile = process.env.SHELF_VERIFY_EVENTS;
const origin = process.env.SHELF_VERIFY_ORIGIN;
const nativeFetch = globalThis.fetch;
const app = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const owner = "0x1111111111111111111111111111111111111111";
const grant = `0x${"1".repeat(64)}`;
const builder = `0x${"2".repeat(64)}`;
const requestId = "dcr_shelf_verification";
const scope = "perplexity.conversations";
const server = "https://shelf-verifier.invalid";
const approval = "https://app-dev.vana.org";
const gateway = "https://dp-rpc-dev.vana.org";

if (!stateFile || !eventFile || !origin)
  throw new Error("Verifier fixture paths are required.");

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input));
  if (url.origin === origin) return nativeFetch(input, init);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const event = async (stage, details = {}) =>
    appendFile(
      eventFile,
      `${JSON.stringify({ time: Date.now(), stage, ...details })}\n`,
    );
  if (
    url.origin === approval &&
    url.pathname === "/api/data-connection-requests"
  ) {
    await event("request-created", { requestId });
    return Response.json({
      requestId,
      approvalUrl: `${approval}/data-connection-requests/${requestId}?mode=page`,
      appAddress: app,
      network: "moksha",
      expiresAt: "2099-01-01T00:00:00Z",
    });
  }
  if (
    url.origin === approval &&
    url.pathname === `/api/data-connection-requests/${requestId}`
  ) {
    await event("request-status", { status: state.approval });
    return Response.json({
      status: state.approval,
      network: "moksha",
      delivery: "personal_server",
      personalServerUrl: server,
      grantId: grant,
      scopes: [scope],
    });
  }
  if (
    url.origin === approval &&
    url.pathname === `/api/data-connection-requests/${requestId}/consumer-ack`
  ) {
    await event("acknowledgement", { accepted: !state.ackFailure });
    return Response.json({}, { status: state.ackFailure ? 503 : 200 });
  }
  if (url.origin === gateway && url.pathname === `/v1/grants/${grant}`)
    return Response.json({
      data: {
        id: grant,
        grantorAddress: owner,
        granteeId: builder,
        scopes: [scope],
        status: "pending",
        grantVersion: "1",
        expiresAt: null,
        expired: false,
        revokedAt: null,
        fee: {
          asset: "0x0000000000000000000000000000000000000000",
          totalDue: "0",
        },
      },
      proof: {},
    });
  if (url.origin === gateway && url.pathname === `/v1/builders/${app}`)
    return Response.json({
      data: { id: builder, granteeAddress: app },
      proof: {},
    });
  if (
    url.origin === gateway &&
    url.pathname === "/v1/servers" &&
    url.searchParams.get("owner") === owner
  )
    return Response.json({
      active: [{ ownerAddress: owner, serverUrl: server }],
      revoked: [],
      count: 1,
    });
  if (url.origin === server && url.pathname === `/v1/data/${scope}`) {
    const headers = new Headers(init?.headers);
    if (headers.has("X-PAYMENT"))
      throw new Error("Controlled verifier must never transmit a payment.");
    if (state.readInterrupted) {
      await event("read-interrupted");
      throw Object.assign(new TypeError("Synthetic interrupted read"), {
        code: "ECONNRESET",
      });
    }
    await event("data-served", {
      title: state.title,
      version: state.version,
      grantId: grant,
      status: state.readFailure ? 503 : 200,
    });
    if (state.readFailure)
      return Response.json({ error: "fixture_unavailable" }, { status: 503 });
    if (state.saveFailure) {
      const directory = process.env.SHELF_VERIFY_STORAGE;
      if (!directory || !directory.includes("shelf-verify-runtime-"))
        throw Error("Storage control requires the owned runtime");
      const files = (await readdir(directory)).filter((name) =>
        name.endsWith(".json"),
      );
      if (files.length !== 1)
        throw Error("Storage control requires one owned connection");
      const file = `${directory}/${files[0]}`;
      await rename(file, `${file}.fault-backup`);
      await mkdir(file);
      await event("save-failure-activated");
    }
    return Response.json({
      scope,
      data: {
        conversations: [
          {
            id: "verification-thread",
            title: state.title,
            update_time: "2026-10-28T00:00:00Z",
          },
        ],
      },
    });
  }
  await event("blocked-outbound", {
    origin: url.origin,
    pathname: url.pathname,
  });
  throw new Error(
    `Verifier refused unexpected outbound ${url.origin}${url.pathname}`,
  );
};
