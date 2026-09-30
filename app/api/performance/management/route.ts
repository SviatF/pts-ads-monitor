import { NextRequest, NextResponse } from "next/server";
import { sendManagementEscalations, sendRecurringProblemReport, sendWeeklyTeamScorecard } from "@/lib/performance-operations";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = request.nextUrl.searchParams.get("kind") || "escalations";
  try {
    if (kind === "weekly") {
      const [scorecard, recurring] = await Promise.all([sendWeeklyTeamScorecard(), sendRecurringProblemReport()]);
      return NextResponse.json({ ok: true, kind, scorecard, recurring });
    }
    if (kind === "recurring") {
      const recurring = await sendRecurringProblemReport();
      return NextResponse.json({ ok: true, kind, recurring });
    }
    const escalations = await sendManagementEscalations();
    return NextResponse.json({ ok: true, kind: "escalations", escalations });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
