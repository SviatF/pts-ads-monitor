import { NextResponse } from "next/server";
import { buildGoogleOAuthUrl } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.redirect(buildGoogleOAuthUrl());
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
