import {
  createSessionRelayBuilderClient,
  type SessionRelayInitResult as SdkRelaySessionInitResult,
} from "@opendatalabs/vana-sdk/session-relay";
import { privateKeyToAccount } from "viem/accounts";
import { ConnectError, ConnectErrorCode } from "../core/errors.js";
import type {
  SessionRelayConfig,
  SessionInitParams,
  SessionPollResult,
} from "../core/types.js";

/** Raw response from the Session Relay init endpoint. */
export type RelaySessionInitResult = SdkRelaySessionInitResult;

interface RelayErrorLike extends Error {
  details: {
    status?: number;
    relayErrorCode?: string;
  };
}

function isRelayErrorLike(err: unknown): err is RelayErrorLike {
  return (
    err instanceof Error &&
    "details" in err &&
    err.details !== null &&
    typeof err.details === "object"
  );
}

function mapRelayError(
  err: unknown,
  fallbackCode: ConnectErrorCode,
): ConnectError {
  if (err instanceof ConnectError) {
    return err;
  }

  if (isRelayErrorLike(err)) {
    const relayCode = err.details.relayErrorCode;
    const code =
      relayCode === "SESSION_RELAY_POLL_TIMEOUT"
        ? ConnectErrorCode.POLL_TIMEOUT
        : (relayCode ?? fallbackCode);
    return new ConnectError(err.message, code, err.details.status);
  }

  if (err instanceof Error) {
    return new ConnectError(err.message, fallbackCode);
  }

  return new ConnectError(String(err), fallbackCode);
}

/**
 * Low-level client for the Session Relay service.
 *
 * This is a CLI adapter over the Vana SDK Session Relay integration. Session
 * Relay is a Vana-operated service integration for app handoff flows, not a
 * protocol-core primitive.
 *
 * @see {@link createSessionRelay} to create an instance.
 */
export interface SessionRelay {
  /** Creates a new session and returns the raw relay response (sessionId, deepLinkUrl, expiresAt). */
  initSession(params: SessionInitParams): Promise<RelaySessionInitResult>;
  /** Polls the session status once. */
  pollSession(sessionId: string): Promise<SessionPollResult>;
  /**
   * Polls until the session reaches a terminal state (`approved`, `denied`, or `expired`).
   *
   * @param sessionId - The session to poll.
   * @param opts - Optional polling interval (default 2 s) and timeout (default 15 min).
   * @throws {@link ConnectError} with code `POLL_TIMEOUT` if the timeout is exceeded.
   */
  pollUntilComplete(
    sessionId: string,
    opts?: { interval?: number; timeout?: number },
  ): Promise<SessionPollResult>;
}

/**
 * Creates a low-level Session Relay client.
 *
 * Prefer the high-level {@link connect} function for most use cases.
 *
 * @param config - Session Relay configuration.
 * @returns A {@link SessionRelay} instance.
 */
export function createSessionRelay(config: SessionRelayConfig): SessionRelay {
  const account = privateKeyToAccount(config.privateKey);
  const relay = createSessionRelayBuilderClient({
    baseUrl: config.sessionRelayUrl,
    granteeAddress: config.granteeAddress,
    signMessage: (message: string) => account.signMessage({ message }),
  });

  return {
    async initSession(
      params: SessionInitParams,
    ): Promise<RelaySessionInitResult> {
      try {
        return await relay.initSession(params);
      } catch (err) {
        throw mapRelayError(err, ConnectErrorCode.SESSION_INIT_FAILED);
      }
    },

    async pollSession(sessionId: string): Promise<SessionPollResult> {
      try {
        return await relay.pollSession(sessionId);
      } catch (err) {
        throw mapRelayError(err, ConnectErrorCode.POLL_FAILED);
      }
    },

    async pollUntilComplete(
      sessionId: string,
      opts?: { interval?: number; timeout?: number },
    ): Promise<SessionPollResult> {
      try {
        return await relay.pollUntilComplete(sessionId, {
          intervalMs: opts?.interval,
          timeoutMs: opts?.timeout,
        });
      } catch (err) {
        throw mapRelayError(err, ConnectErrorCode.POLL_FAILED);
      }
    },
  };
}
