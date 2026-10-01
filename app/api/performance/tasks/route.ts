import { NextRequest, NextResponse } from "next/server";
import { sendDailyPerformanceTasks, sendUnfinishedTaskReminder } from "@/lib/performance-tasks-v2";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = request.nextUrl.searchParams.get("kind") === "reminder" ? "reminder" : "morning";
  try {
    const result = kind === "reminder" ? await sendUnfinishedTaskReminder() : await sendDailyPerformanceTasks();
    return NextResponse.json({ ok: true, kind, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
