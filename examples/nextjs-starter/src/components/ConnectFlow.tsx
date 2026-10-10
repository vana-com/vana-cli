"use client";

import {
  useDirectVanaConnect,
  type DirectConnectState,
} from "@opendatalabs/vana-sdk/react";
import { useState } from "react";
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

const STATUS_DISPLAY: Record<
  DirectConnectState["type"],
  { label: string; className: string }
> = {
  idle: { label: "Ready to connect", className: "status-default" },
  creating: { label: "Creating request", className: "status-default" },
  awaiting_approval: {
    label: "Waiting for approval",
    className: "status-waiting",
  },
  ready_to_open: {
    label: "Open Vana to continue",
    className: "status-waiting",
  },
  reading: { label: "Reading approved data", className: "status-approved" },
  done: { label: "Data received", className: "status-approved" },
  error: { label: "Action needed", className: "status-error" },
};

export default function ConnectFlow() {
  const [retrying, setRetrying] = useState(false);
  const { state, start, retryRead, reset } = useDirectVanaConnect({
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
      checkedResponse<ApprovedDataResult>(
        await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        }),
      ),
  });
  const display = STATUS_DISPLAY[state.type];
  const approvalUrl =
    state.type === "ready_to_open"
      ? state.mobileContinuationUrl
      : state.type === "awaiting_approval" && state.popupBlocked
        ? state.request.approvalUrl
        : undefined;

  return (
    <div data-slot="connect-flow">
      <div
        className={`card ${state.type === "done" ? "card-approved" : state.type === "error" ? "card-error" : ""}`}
      >
        <div className="field-row" style={{ marginBottom: 20 }}>
          <span className="label">Status</span>
          <span className={`mono ${display.className}`} role="status">
            {display.label}
          </span>
        </div>
        {state.type === "idle" && (
          <>
            <p>
              Approve access in Vana. This app automatically reads your ChatGPT
              conversations after approval.
            </p>
            <button
              type="button"
              onClick={start}
              className="btn-primary"
              style={{ width: "100%" }}
            >
              Connect with Vana
            </button>
          </>
        )}
        {state.type === "creating" && (
          <p>
            <span className="spinner" /> Creating access request...
          </p>
        )}
        {state.type === "awaiting_approval" && (
          <p>
            {state.popupBlocked
              ? "Your browser blocked the approval tab. Open it below to continue."
              : "Complete approval in the Vana tab. Your data will appear here."}
          </p>
        )}
        {approvalUrl && (
          <a
            href={approvalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
            style={{
              display: "block",
              textAlign: "center",
              textDecoration: "none",
            }}
          >
            {state.type === "ready_to_open" ? "Open Vana" : "Open approval"}
          </a>
        )}
        {state.type === "reading" && (
          <p>
            <span className="spinner" /> Reading your approved data...
          </p>
        )}
        {state.type === "done" && (
          <>
            <div className="label">{state.result.scope}</div>
            <pre className="pre-block" style={{ maxHeight: 400 }}>
              {JSON.stringify(state.result.data, null, 2)}
            </pre>
          </>
        )}
        {state.type === "error" && (
          <>
            <p className="text-error" role="alert">
              {state.error.message}
            </p>
            <button
              type="button"
              onClick={() => {
                setRetrying(true);
                void retryRead()
                  .catch(() => {
                    // The SDK reports retry failures through state.error too.
                  })
                  .finally(() => setRetrying(false));
              }}
              disabled={retrying}
              className="btn-primary"
              style={{ width: "100%" }}
            >
              {retrying ? "Trying again..." : "Try again"}
            </button>
          </>
        )}
      </div>
      {(state.type === "done" || state.type === "error") && !retrying && (
        <button
          type="button"
          onClick={reset}
          className="btn-ghost"
          style={{ marginTop: 12 }}
        >
          Reset
        </button>
      )}
    </div>
  );
}
