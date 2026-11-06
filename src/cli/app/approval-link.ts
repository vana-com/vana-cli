import type { ResolvedNetwork } from "../../core/network.js";
import {
  detectPersonalServerTarget,
  urlsMatch,
} from "../../personal-server/index.js";
import { lookupRegisteredServers } from "../../personal-server/registered.js";
import { getAccountUrl, loadCredentials } from "../auth.js";

const ADDRESS = /^0x[0-9a-f]{40}$/i;

interface ApprovalLinkDeps {
  accountUrl?: typeof getAccountUrl;
  credentials?: typeof loadCredentials;
  detectTarget?: typeof detectPersonalServerTarget;
  lookupServers?: typeof lookupRegisteredServers;
  fetchFn?: typeof fetch;
}

/** Add a routing hint only for an Account-owned app and its configured registered server. */
export async function resolveApprovalLink(
  approvalUrl: string,
  network: ResolvedNetwork,
  appAddress: string,
  requestedOwner?: string,
  deps: ApprovalLinkDeps = {},
): Promise<string> {
  try {
    const url = new URL(approvalUrl);
    if (
      url.origin !== network.approvalUrl ||
      !/^\/data-connection-requests\/[^/]+$/.test(url.pathname) ||
      url.searchParams.has("server_address") ||
      (deps.accountUrl ?? getAccountUrl)() !== network.accountUrl
    ) {
      return approvalUrl;
    }

    const account = (deps.credentials ?? loadCredentials)()?.account;
    if (
      !account?.session_token ||
      !ADDRESS.test(account.address) ||
      (requestedOwner &&
        requestedOwner.toLowerCase() !== account.address.toLowerCase())
    ) {
      return approvalUrl;
    }

    const target = await (deps.detectTarget ?? detectPersonalServerTarget)();
    const health = target.health;
    if (
      !target.source ||
      target.source === "scan" ||
      health?.status !== "healthy" ||
      health.owner?.toLowerCase() !== account.address.toLowerCase() ||
      !health.identity ||
      !ADDRESS.test(health.identity) ||
      !health.apiOrigin
    ) {
      return approvalUrl;
    }

    const ownershipUrl = new URL(
      "/api/v1/me/app-ownership",
      network.accountUrl,
    );
    ownershipUrl.searchParams.set("address", appAddress.toLowerCase());
    ownershipUrl.searchParams.set("network", network.name);
    const [response, registrations] = await Promise.all([
      (deps.fetchFn ?? fetch)(ownershipUrl, {
        headers: { authorization: `Bearer ${account.session_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
      (deps.lookupServers ?? lookupRegisteredServers)(account.address),
    ]);
    if (!response.ok) return approvalUrl;
    const ownership = await response.json();
    if (
      ownership?.object !== "app_ownership" ||
      ownership.ownership !== "owned" ||
      ownership.appAddress !== appAddress.toLowerCase() ||
      ownership.network !== network.name
    ) {
      return approvalUrl;
    }

    const server = registrations.find(
      ({ network: registeredNetwork, serverAddress, url: registeredUrl }) =>
        registeredNetwork === network.name &&
        serverAddress.toLowerCase() === health.identity?.toLowerCase() &&
        urlsMatch(registeredUrl, health.apiOrigin ?? ""),
    );
    if (!server) return approvalUrl;
    url.searchParams.set("server_address", server.serverAddress);
    return url.href;
  } catch {
    // The server hint is optional. Consent can resolve the server with the owner.
    return approvalUrl;
  }
}
