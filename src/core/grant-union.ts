/**
 * Extend an app's live grant instead of replacing it.
 *
 * The gateway keeps one grant per owner and app, and a new approval
 * replaces that grant's scopes. A request for `whoop.recovery` from an app
 * that holds `oura.sleep` would leave it with `whoop.recovery` alone, so a
 * request has to carry what the grant already covers.
 *
 * Local copy of `mergeWithLiveGrant` / `unionGrantScopes` from
 * `@opendatalabs/vana-sdk` (added in vana-sdk#215, not released yet; this
 * package pins 4.0.0). Same names, inputs and outputs, so the swap is an
 * import change once the SDK ships it.
 */

import type { GatewayClient } from "@opendatalabs/vana-sdk";
import { parseScope, parseScopeEntry } from "@opendatalabs/vana-sdk/server";

type GrantListItem = Awaited<
  ReturnType<GatewayClient["listGrantsByUser"]>
>[number];

/** The slice of the gateway client the helpers read through. */
export type GrantUnionGateway = Pick<GatewayClient, "listGrantsByUser"> &
  Partial<Pick<GatewayClient, "getBuilder">>;

export interface MergeWithLiveGrantInput {
  gateway: GrantUnionGateway;
  /** The data owner (grantor) whose live grant to extend. */
  owner: string;
  /** The app's bytes32 builder id; or pass `appAddress`. */
  granteeId?: string;
  /** Resolved to `granteeId` through `gateway.getBuilder` when needed. */
  appAddress?: string;
  scopes: readonly string[];
  /** Live entries the app gives up, matched verbatim. */
  removeScopes?: readonly string[];
}

export interface GrantUnion {
  /** What to send on the new request. */
  scopes: string[];
  /** Live entries carried over. */
  kept: string[];
  /** Requested entries the live grant did not cover. */
  added: string[];
  /** Live entries dropped because they were in `removeScopes`. */
  removed: string[];
  /** Live entries a request cannot carry (wildcards, unknown operations). */
  notCarried: string[];
  liveScopes: string[];
}

export interface MergeWithLiveGrantResult extends GrantUnion {
  status: "merged" | "no_live_grant";
  grantId?: string;
}

export class GrantUnionConflictError extends Error {
  constructor(readonly conflicting: string[]) {
    super(
      `${conflicting.join(", ")} cannot be both requested and removed. Drop it from --scopes or from --remove-scopes.`,
    );
    this.name = "GrantUnionConflictError";
  }
}

// A concrete scope with a known operation prefix: what a data connection
// request accepts. Wildcards (`chatgpt.*`) and unknown operations are not.
function isCarryable(entry: string): boolean {
  try {
    parseScope(parseScopeEntry(entry).scope);
    return true;
  } catch {
    return false;
  }
}

const dedupe = (entries: readonly string[]) => [...new Set(entries)];

export function unionGrantScopes(
  liveScopes: readonly string[],
  scopes: readonly string[],
  removeScopes: readonly string[] = [],
): GrantUnion {
  const remove = new Set(removeScopes);
  const conflicting = scopes.filter((entry) => remove.has(entry));
  if (conflicting.length > 0) {
    throw new GrantUnionConflictError(conflicting);
  }
  const live = dedupe(liveScopes);
  const liveSet = new Set(live);
  const requested = dedupe(scopes);
  const remaining = live.filter((entry) => !remove.has(entry));
  const kept = remaining.filter((entry) => isCarryable(entry));
  const added = requested.filter((entry) => !liveSet.has(entry));
  return {
    scopes: dedupe([...kept, ...added]),
    kept,
    added,
    removed: live.filter((entry) => remove.has(entry)),
    notCarried: remaining.filter((entry) => !isCarryable(entry)),
    liveScopes: live,
  };
}

/** The owner's active grant for one app, newest version first. */
export async function findLiveGrant(
  gateway: Pick<GatewayClient, "listGrantsByUser">,
  owner: string,
  granteeId: string,
): Promise<GrantListItem | null> {
  const grants = await gateway.listGrantsByUser(owner);
  const matching = grants
    .filter(
      (grant) =>
        grant.granteeId.toLowerCase() === granteeId.toLowerCase() &&
        !grant.revokedAt &&
        !grant.expired,
    )
    .sort((a, b) => {
      const av = BigInt(a.grantVersion || "0");
      const bv = BigInt(b.grantVersion || "0");
      return av === bv ? 0 : av > bv ? -1 : 1;
    });
  return matching[0] ?? null;
}

export async function liveGrantScopes(
  gateway: Pick<GatewayClient, "listGrantsByUser">,
  owner: string,
  granteeId: string,
): Promise<string[]> {
  const grant = await findLiveGrant(gateway, owner, granteeId);
  return grant ? [...grant.scopes] : [];
}

export async function mergeWithLiveGrant(
  input: MergeWithLiveGrantInput,
): Promise<MergeWithLiveGrantResult> {
  const removeScopes = input.removeScopes ?? [];
  unionGrantScopes([], input.scopes, removeScopes);
  let granteeId = input.granteeId ?? null;
  if (!granteeId) {
    if (!input.appAddress || !input.gateway.getBuilder) {
      throw new Error(
        "mergeWithLiveGrant needs granteeId, or appAddress and gateway.getBuilder.",
      );
    }
    granteeId = (await input.gateway.getBuilder(input.appAddress))?.id ?? null;
  }
  const grant = granteeId
    ? await findLiveGrant(input.gateway, input.owner, granteeId)
    : null;
  if (!grant) {
    return {
      status: "no_live_grant",
      ...unionGrantScopes([], input.scopes, removeScopes),
    };
  }
  return {
    status: "merged",
    grantId: grant.id,
    ...unionGrantScopes(grant.scopes, input.scopes, removeScopes),
  };
}
