/**
 * Extend an app's live grant instead of replacing it.
 *
 * The gateway keeps one grant per owner and app, and a new approval
 * replaces that grant's scopes. A request for `whoop.recovery` from an app
 * that holds `oura.sleep` would leave it with `whoop.recovery` alone, so a
 * request has to carry what the grant already covers.
 *
 * The merge itself lives in `@opendatalabs/vana-sdk` (`mergeWithLiveGrant`,
 * `unionGrantScopes`). This module only adds the CLI's flag-worded
 * requested/removed conflict check, run before any network call.
 */

export {
  findLiveGrant,
  liveGrantScopes,
  mergeWithLiveGrant,
  unionGrantScopes,
  type GrantUnion,
  type GrantUnionGateway,
  type MergeWithLiveGrantInput,
  type MergeWithLiveGrantResult,
} from "@opendatalabs/vana-sdk/server";

export class GrantUnionConflictError extends Error {
  constructor(readonly conflicting: string[]) {
    super(
      `${conflicting.join(", ")} cannot be both requested and removed. Drop it from --scopes or from --remove-scopes.`,
    );
    this.name = "GrantUnionConflictError";
  }
}

/**
 * Refuse an entry that is both requested and removed, worded for the CLI
 * flags. The SDK makes the same check, but its message names its own
 * option names.
 */
export function assertNoGrantUnionConflict(
  scopes: readonly string[],
  removeScopes: readonly string[],
): void {
  const remove = new Set(removeScopes);
  const conflicting = [...new Set(scopes.filter((entry) => remove.has(entry)))];
  if (conflicting.length > 0) {
    throw new GrantUnionConflictError(conflicting);
  }
}
