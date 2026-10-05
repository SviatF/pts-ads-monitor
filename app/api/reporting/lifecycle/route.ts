import { NextResponse } from "next/server";
import { listReportingConfigs } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { applyReportFormulas } from "@/lib/report-formulas";
import { applyReportCurrencyFormats } from "@/lib/report-currency";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const configs = await listReportingConfigs();
  const results: Array<{ accountId: string; created?: string[]; error?: string }> = [];

  for (const config of configs.filter((item) => item.status === "configured")) {
    try {
      const lifecycle = await ensureProjectReportLifecycle({
        spreadsheetId: config.report_file_id,
        projectName: config.project_name,
        goalKey: config.goal_key,
        goalLabel: config.goal_label,
        reportingStartDate: config.report_start_date,
      });
      await applyReportFormulas(config.report_file_id);
      await applyReportCurrencyFormats(config.report_file_id, config.currency || "USD");
      results.push({ accountId: config.meta_account_id, created: lifecycle.created });
    } catch (error) {
      results.push({ accountId: config.meta_account_id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return NextResponse.json({ ok: true, projects: results.length, results });
}
