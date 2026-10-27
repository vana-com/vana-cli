import { NextResponse } from "next/server";

/** Data reads and payment authorization belong to the next delivery step. */
export async function POST(): Promise<Response> {
  return NextResponse.json(
    {
      code: "read_not_enabled",
      error:
        "Data reads are not enabled in this demo yet. No payment has been authorized.",
    },
    { status: 501, headers: { "Cache-Control": "no-store" } },
  );
}
