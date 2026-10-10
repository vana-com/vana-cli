import { NextResponse } from "next/server";
import {
  AccessNotApprovedError,
  PaymentRequiredError,
  ScopeNotApprovedError,
} from "@opendatalabs/vana-sdk/server";
import { config, vana } from "@/config";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("requestId" in body) ||
    Object.keys(body).length !== 1 ||
    typeof body.requestId !== "string" ||
    body.requestId.length > 256 ||
    !/^dcr_[a-z0-9_-]+$/i.test(body.requestId)
  ) {
    return NextResponse.json(
      { error: "Expected only a valid requestId" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await vana.readApprovedData({
        requestId: body.requestId,
        scope: config.scopes[0],
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      return NextResponse.json(
        {
          error: "Payment required. This starter does not authorize payments.",
        },
        { status: 402 },
      );
    }
    if (error instanceof AccessNotApprovedError) {
      return NextResponse.json(
        { error: "Request is not ready for a Personal Server read" },
        { status: 409 },
      );
    }
    if (error instanceof ScopeNotApprovedError) {
      return NextResponse.json(
        { error: "The configured scope was not approved" },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "Failed to read approved data" },
      { status: 500 },
    );
  }
}
