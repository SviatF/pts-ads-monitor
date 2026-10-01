import { NextRequest, NextResponse } from "next/server";
import { sendPerformanceBrief } from "@/lib/performance-brief";
import { sendSalesReportingCompleteness } from "@/lib/sales-reporting-completeness";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = request.nextUrl.searchParams.get("kind") === "evening" ? "evening" : "morning";
  try {
    const result = await sendPerformanceBrief(kind);
    let sales_data: Awaited<ReturnType<typeof sendSalesReportingCompleteness>> | null = null;
    if (kind === "evening") {
      try {
        sales_data = await sendSalesReportingCompleteness();
      } catch (error) {
        console.error("Sales reporting completeness check failed", error);
      }
    }
    return NextResponse.json({ ok: true, ...result, sales_data });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
