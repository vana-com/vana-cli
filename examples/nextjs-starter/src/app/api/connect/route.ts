import { NextResponse } from "next/server";
import { config, vana } from "@/config";

export async function POST() {
  try {
    return NextResponse.json(
      await vana.createAccessRequest({ returnUrl: config.appUrl }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to create access request" },
      { status: 500 },
    );
  }
}
