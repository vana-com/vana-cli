import "server-only";
import { NextResponse } from "next/server";
import {
  PersonalServerReadError,
  PaymentRequiredError,
} from "@opendatalabs/vana-sdk/server";
import { DeliveryError } from "./delivery.js";
import { config } from "../config.js";

export const SESSION_COOKIE = "research_shelf";

export function session(request: Request): string {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new DeliveryError(
      "connection_required",
      "Connect this browser with Vana first.",
      401,
    );
  return token;
}

export function sameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(config.appUrl).origin)
    throw new DeliveryError(
      "origin_refused",
      "Open Research Shelf directly to continue.",
      403,
    );
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function failure(error: unknown) {
  console.warn("research-shelf.operation", {
    name: error instanceof Error ? error.name : "unknown",
    code:
      error instanceof DeliveryError
        ? error.code
        : (error as { code?: unknown })?.code,
    status: (error as { status?: unknown })?.status,
  });
  if (error instanceof PaymentRequiredError)
    return json(
      {
        code: "payment_unconfirmed",
        error:
          "The server has not confirmed payment. Its signed receipt is retained; no automatic repayment will occur.",
      },
      402,
    );
  if (error instanceof PersonalServerReadError) {
    const status = error.status;
    if (status === 401 || status === 403)
      return json(
        {
          code: "grant_refused",
          error: "The server refused this app's grant. Review access in Vana.",
        },
        403,
      );
    if (status === 404 || status === 409)
      return json(
        {
          code: "data_not_ready",
          error:
            "The requested conversations are missing or still syncing. Collect and sync them before trying again.",
        },
        409,
      );
    return json(
      {
        code: "server_unavailable",
        error:
          "The Personal Server could not serve conversations. Your saved list and payment receipt are retained.",
      },
      502,
    );
  }
  if (error instanceof DeliveryError)
    return json({ code: error.code, error: error.message }, error.status);
  if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
    return json(
      {
        code: "read_in_progress",
        error:
          "The local store is locked by another action or an interrupted process. Check the demo recovery instructions before retrying.",
      },
      409,
    );
  return json(
    {
      code: "delivery_unavailable",
      error:
        "The data operation could not finish. Any saved result and payment receipt are retained.",
    },
    502,
  );
}

export async function onlyString(
  request: Request,
  field: string,
): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DeliveryError("invalid_input", "Invalid JSON body.", 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !(field in body) ||
    typeof (body as Record<string, unknown>)[field] !== "string"
  )
    throw new DeliveryError("invalid_input", `Expected only ${field}.`, 400);
  const value = (body as Record<string, string>)[field];
  if (value.length > 256 || !value.length)
    throw new DeliveryError("invalid_input", `Invalid ${field}.`, 400);
  return value;
}
