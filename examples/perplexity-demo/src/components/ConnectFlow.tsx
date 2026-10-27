"use client";

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
  creating: "Creating request",
  awaiting_approval: "Waiting for approval",
  ready_to_open: "Desktop browser required",
  reading: "Checking read availability",
  done: "Approval flow finished",
  error: "Action needed",
};

export default function ConnectFlow() {
  const { state, start, reset } = useDirectVanaConnect({
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

  return (
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
            onClick={start}
            className="btn-primary full-width"
          >
            Connect with Vana
          </button>
        </>
      )}
      {state.type === "creating" && (
        <p>
          <span className="spinner" aria-hidden="true" /> Creating your approval
          request…
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
          Use a desktop browser for this CLI-first demo. Mobile and Desktop app
          handoffs are later work.
        </p>
      )}
      {state.type === "reading" && (
        <p>
          <span className="spinner" aria-hidden="true" /> Checking whether this
          demo can read your data…
        </p>
      )}
      {state.type === "done" && (
        <p>
          The approval flow finished. This version does not load or save
          conversation data.
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
            onClick={reset}
          >
            Start again
          </button>
        </>
      )}
    </section>
  );
}
