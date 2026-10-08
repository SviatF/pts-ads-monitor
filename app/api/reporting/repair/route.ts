import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      disabled: true,
      message: "Automatic reporting repair is disabled. Use the normal 09:00 sync or manual period sync.",
    },
    { status: 410 },
  );
}
