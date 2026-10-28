/** Resumable Moksha funding before an access request is created. */
import {
  createGatewayClient,
  type GatewayClient,
} from "@opendatalabs/vana-sdk";
import type { ResolvedAppKey } from "../../core/app-key.js";
import type { ResolvedNetwork } from "../../core/network.js";
import type {
  RequestsStore,
  StoredRequestIntent,
} from "../../core/requests-store.js";
import { requestTestCredit } from "../../core/test-credit.js";
import { buildClaimLink } from "./claim.js";
import { signBuilderRegistration } from "./register.js";
import type { AppCommandOptions, AppOutcomeInput } from "./outcome.js";

/** Finish one saved funding operation; returning null permits consent creation. */
export async function prepareTestCredit(input: {
  intent: StoredRequestIntent;
  network: ResolvedNetwork;
  key: ResolvedAppKey;
  requests: RequestsStore;
  options: AppCommandOptions & { timeout?: string };
  resumeCommand: string;
  fetchFn?: typeof fetch;
  createClient?: (
    url: string,
  ) => Pick<GatewayClient, "isRegisteredBuilder" | "registerBuilder">;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<AppOutcomeInput | null> {
  const { intent, network, key, requests, options } = input;
  if (!intent.funding) return null;
  const outcome = (
    code: string,
    message: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): AppOutcomeInput => ({
    status: "failed",
    code,
    message,
    network: network.name,
    remedy: input.resumeCommand,
    data: {
      setupId: intent.setupId,
      stage: "test_credit",
      reason,
      operationId: intent.fundingProgress?.operationId ?? null,
      ...extra,
    },
  });
  if (
    network.name !== "moksha" ||
    intent.funding.accountUrl !== network.accountUrl
  )
    return outcome(
      "bad_usage",
      "Cannot resume test credit in another environment or network.",
      "funding_context_mismatch",
    );
  if (["funded", "not_needed"].includes(intent.fundingProgress?.status ?? ""))
    return null;
  if (intent.fundingProgress?.status === "failed")
    return outcome(
      "not_ready",
      "The saved test-credit operation failed. Ask the service operator to inspect it before starting a new setup.",
      "funding_failed",
    );

  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = Number(options.timeout ?? 120) * 1000;
  const deadline =
    now() + (Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 120_000);
  if (!options.json && !options.quiet)
    process.stderr.write(
      intent.fundingProgress?.operationId
        ? "Checking the saved test-credit operation...\n"
        : "Requesting free Moksha test credit...\n",
    );
  for (;;) {
    let result;
    try {
      result = await requestTestCredit({
        network,
        privateKey: key.privateKey,
        idempotencyKey: intent.funding.idempotencyKey,
        operationId: intent.fundingProgress?.operationId,
        fetchFn: input.fetchFn,
      });
    } catch {
      return outcome(
        "not_ready",
        "Test-credit progress could not be checked. Resume this setup to recover the same funding request.",
        "funding_unavailable",
      );
    }
    if (result.status === "refused") {
      if (
        result.code === "claim_required" &&
        !intent.fundingProgress?.operationId
      ) {
        try {
          const client = (input.createClient ?? createGatewayClient)(
            network.gatewayUrl,
          );
          if (!(await client.isRegisteredBuilder(key.address))) {
            await client.registerBuilder(
              await signBuilderRegistration(
                key,
                network,
                intent.app.homepageUrl,
              ),
            );
          }
          const link = await buildClaimLink({
            privateKey: key.privateKey,
            network,
            appName: intent.app.name,
          });
          return {
            ...outcome(
              "confirmation_required",
              "Claim this app in your Vana Account, then resume setup for free test credit.",
              "claim_required",
              { claimUrl: link.url, expiresAt: link.expiry },
            ),
            remedy: `Open ${link.url}, then: ${input.resumeCommand}`,
          };
        } catch {
          return outcome(
            "not_ready",
            "The app could not be prepared for claiming. Resume this setup to try again with the same app.",
            "claim_unavailable",
          );
        }
      }
      const messages: Record<string, string> = {
        account_cap_reached:
          "This Account has reached its daily test-credit limit. Resume after the limit resets.",
        global_cap_reached:
          "Free test credit has reached its daily service limit. Resume later.",
        inactive:
          "This app is not eligible for another top-up: it has no paid read in the last seven days.",
        test_credits_disabled:
          "Free Moksha test credit is currently switched off. Resume once it is enabled.",
        test_credits_paused:
          "Free Moksha test credit is paused. Resume once the service is ready.",
      };
      return outcome(
        "not_ready",
        messages[result.code] ??
          "Free Moksha test credit is unavailable. Resume this setup when the service is ready.",
        result.code,
        result.retryAfterSeconds
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {},
      );
    }
    let progress: NonNullable<StoredRequestIntent["fundingProgress"]> =
      result.status === "not_needed"
        ? { status: "not_needed" }
        : {
            status:
              result.operation.status === "confirmed"
                ? "funded"
                : result.operation.status === "failed"
                  ? "failed"
                  : "pending",
            operationId: result.operation.id,
          };
    try {
      progress = requests.updateFunding(intent.setupId, progress);
      intent.fundingProgress = progress;
    } catch {
      return outcome(
        "internal",
        "Cannot save test-credit progress. Resume the same setup; do not request a replacement.",
        "funding_storage_failed",
      );
    }
    if (progress.status === "not_needed" || progress.status === "funded") {
      if (!options.json && !options.quiet)
        process.stderr.write(
          progress.status === "funded"
            ? "Free test credit is ready.\n"
            : "Existing test credit is sufficient.\n",
        );
      return null;
    }
    if (progress.status === "failed")
      return outcome(
        "not_ready",
        "The test-credit operation failed. Ask the service operator to inspect it before starting a new setup.",
        "funding_failed",
      );
    if (options.noInput || now() >= deadline)
      return outcome(
        "not_ready",
        "Free test credit is still being prepared. Resume the saved setup to check it.",
        "funding_pending",
      );
    await sleep(Math.min(3_000, Math.max(0, deadline - now())));
  }
}
