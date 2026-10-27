import { NextResponse } from "next/server";
import { shelf } from "../../../config.js";
import { failure, json, session } from "../../../server/http.js";

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
    return json(await shelf.status(session(request), requestId));
  } catch (error) {
    return failure(error);
  }
}
