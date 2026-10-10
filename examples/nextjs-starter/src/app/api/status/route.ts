import { NextResponse } from "next/server";
import { vana } from "@/config";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestId = params.get("requestId");
  if (
    !requestId ||
    requestId.length > 256 ||
    !/^dcr_[a-z0-9_-]+$/i.test(requestId) ||
    params.getAll("requestId").length !== 1
  ) {
    return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
  }
  try {
    return NextResponse.json(await vana.getAccessRequestStatus(requestId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to check access request" },
      { status: 500 },
    );
  }
}
