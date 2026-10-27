"use client";

import { useEffect, useRef, useState } from "react";
import type { Connection } from "../server/store.js";

import {
  useDirectVanaConnect,
  type DirectConnectState,
} from "@opendatalabs/vana-sdk/react";
import type {
  AccessRequest,
  AccessRequestStatus,
  ApprovedDataResult,
} from "@opendatalabs/vana-sdk/server";

async function checkedResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Request failed (${response.status})`,
    );
  }
  return body;
}

const STATUS: Record<DirectConnectState["type"], string> = {
  idle: "Ready to connect",
  creating: "Preparing connection",
  awaiting_approval: "Waiting for approval",
  ready_to_open: "Desktop browser required",
  reading: "Reading conversations",
  done: "Conversations saved",
  error: "Action needed",
};

export default function ConnectFlow() {
  const [saved, setSaved] = useState<Connection["saved"]>();
  const [acknowledgedRevision, setAcknowledgedRevision] = useState<string>();
  const displayedRevision = useRef<string | undefined>(undefined);
  const connectionGeneration = useRef(0);
  const acknowledged = !!saved && acknowledgedRevision === saved.revision;
  const [ackError, setAckError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [reviewRequired, setReviewRequired] = useState(false);
  const { state, start, reset, retryRead } = useDirectVanaConnect<
    NonNullable<Connection["saved"]>
  >({
    createRequest: async () =>
      checkedResponse<AccessRequest>(
        await fetch("/api/connect", { method: "POST" }),
      ),
    getStatus: async (requestId) =>
      checkedResponse<AccessRequestStatus>(
        await fetch(`/api/status?requestId=${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        }),
      ),
    readResult: async (requestId) =>
      checkedResponse<ApprovedDataResult<NonNullable<Connection["saved"]>>>(
        await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        }),
      ),
  });

  useEffect(() => {
    let active = true;
    const generation = connectionGeneration.current;
    fetch("/api/data", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const snapshot = await response.json();
        if (
          active &&
          connectionGeneration.current === generation &&
          snapshot.saved
        ) {
          setSaved(snapshot.saved);
          setAcknowledgedRevision(
            snapshot.acknowledged ? snapshot.saved.revision : undefined,
          );
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (state.type === "done") {
      setSaved(state.result.data);
      setAcknowledgedRevision(undefined);
    }
  }, [state]);

  async function acknowledge(revision: string) {
    const generation = connectionGeneration.current;
    setAckError(undefined);
    try {
      await checkedResponse(
        await fetch("/api/acknowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision }),
        }),
      );
      if (
        displayedRevision.current === revision &&
        connectionGeneration.current === generation
      )
        setAcknowledgedRevision(revision);
    } catch (error) {
      if (
        displayedRevision.current !== revision ||
        connectionGeneration.current !== generation
      )
        return;
      setAckError(
        error instanceof Error ? error.message : "Confirmation did not finish.",
      );
    }
  }

  async function readLatest() {
    const generation = connectionGeneration.current;
    setRefreshing(true);
    setRefreshError(undefined);
    setReviewRequired(false);
    try {
      const response = await fetch("/api/latest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok && connectionGeneration.current === generation) {
        const refusal = await response
          .clone()
          .json()
          .catch(() => undefined);
        setReviewRequired(
          [401, 403].includes(response.status) ||
            ["approval_required", "grant_invalid", "grant_refused"].includes(
              refusal?.code,
            ),
        );
      }
      const result =
        await checkedResponse<
          ApprovedDataResult<NonNullable<Connection["saved"]>>
        >(response);
      if (connectionGeneration.current !== generation) return;
      setSaved(result.data);
      setAcknowledgedRevision(undefined);
      setAckError(undefined);
      setReviewRequired(false);
    } catch (error) {
      if (connectionGeneration.current !== generation) return;
      setRefreshError(
        error instanceof Error
          ? error.message
          : "The latest read did not finish.",
      );
    } finally {
      if (connectionGeneration.current === generation) setRefreshing(false);
    }
  }

  // Effects run after the saved list has committed to the DOM.
  // A new connection can recover the same revision and still needs its own ack.
  useEffect(() => {
    displayedRevision.current = saved?.revision;
    if (saved && !acknowledged) void acknowledge(saved.revision);
    return () => {
      displayedRevision.current = undefined;
    };
  }, [saved]);

  return (
    <>
      <section
        className="card"
        data-slot="connect-flow"
        aria-label="Connect Perplexity"
      >
        <div className="field-row">
          <span className="label">Connection</span>
          <span
            className={state.type === "error" ? "status-error" : "mono"}
            role="status"
          >
            {STATUS[state.type]}
          </span>
        </div>
        {state.type === "idle" && (
          <>
            <p>
              Run the Perplexity connector with the CLI first. Then open Vana to
              review this app and the conversations it requests.
            </p>
            <button
              type="button"
              onClick={() => {
                connectionGeneration.current++;
                setAckError(undefined);
                setRefreshError(undefined);
                setReviewRequired(false);
                setRefreshing(false);
                void start();
              }}
              className="btn-primary full-width"
              disabled={refreshing}
            >
              Connect with Vana
            </button>
          </>
        )}
        {state.type === "creating" && (
          <p>
            <span className="spinner" aria-hidden="true" /> Preparing your
            connection…
          </p>
        )}
        {state.type === "awaiting_approval" && (
          <>
            <p>
              {state.popupBlocked
                ? "The approval tab was blocked. Open it below to continue."
                : "Review the request in the Vana tab. This page will wait for its result."}
            </p>
            <a
              className="btn-primary approval-link"
              href={state.request.approvalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open approval
            </a>
          </>
        )}
        {state.type === "ready_to_open" && (
          <p>
            Use a desktop browser for this CLI-first demo. Mobile and Desktop
            app handoffs are later work.
          </p>
        )}
        {state.type === "reading" && (
          <p>
            <span className="spinner" aria-hidden="true" /> Reading and saving
            your Perplexity conversations…
          </p>
        )}
        {state.type === "done" && (
          <p>
            Conversations saved.{" "}
            {acknowledged
              ? "Delivery confirmed in Vana."
              : ackError
                ? "Delivery confirmation needs retry."
                : "Confirming delivery in Vana…"}
          </p>
        )}
        {state.type === "error" && (
          <>
            <p className="text-error" role="alert">
              {state.error.message}
            </p>
            <button
              type="button"
              className="btn-primary full-width"
              onClick={() => void retryRead()}
            >
              Try read again
            </button>
          </>
        )}
        {state.type === "error" && (
          <button type="button" className="btn-ghost" onClick={reset}>
            Review access again
          </button>
        )}
      </section>
      <section className="card threads" aria-labelledby="threads-title">
        <h2 id="threads-title">Your threads</h2>
        {!saved ? (
          <p className="empty-state">No threads loaded.</p>
        ) : (
          <>
            <p>
              {saved.threads.length} conversations saved ·{" "}
              {new Date(saved.savedAt).toLocaleString()}
            </p>
            {saved.threads.length === 0 ? (
              <p>No conversations returned by the source.</p>
            ) : (
              <ul className="thread-list">
                {saved.threads.map((thread) => (
                  <li key={thread.id}>
                    <span>{thread.title ?? "Untitled conversation"}</span>
                    <time dateTime={thread.updatedAt ?? undefined}>
                      {thread.updatedAt
                        ? new Date(thread.updatedAt).toLocaleString()
                        : "Update time unavailable"}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {saved && (
          <>
            <button
              type="button"
              className="btn-primary full-width"
              disabled={
                refreshing ||
                !acknowledged ||
                !["idle", "done", "error"].includes(state.type)
              }
              onClick={() => void readLatest()}
            >
              {refreshing ? "Reading latest…" : "Read latest"}
            </button>
            {refreshError && (
              <p className="text-error" role="alert">
                Your saved list is still available. {refreshError}
              </p>
            )}
            {reviewRequired && state.type !== "idle" && (
              <button type="button" className="btn-ghost" onClick={reset}>
                Review access again
              </button>
            )}
          </>
        )}
        {ackError && (
          <>
            <p className="text-error" role="alert">
              Your conversations are saved. {ackError}
            </p>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => saved && void acknowledge(saved.revision)}
            >
              Retry confirmation
            </button>
          </>
        )}
      </section>
    </>
  );
}
