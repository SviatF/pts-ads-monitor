import { NextRequest, NextResponse } from "next/server";
import { runPerformanceMonitor } from "@/lib/performance-monitor-v4";
import { notifyConfirmedWinnerCreatives } from "@/lib/performance-positive-notifier";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runPerformanceMonitor();
    let winners = { sent: 0 };
    try {
      winners = await notifyConfirmedWinnerCreatives();
    } catch (error) {
      console.error("Winner creative notifier failed", error);
    }
    return NextResponse.json({ ok: true, ...result, winner_notifications: winners.sent });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
