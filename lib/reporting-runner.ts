import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import { applyReportCurrencyFormats } from "@/lib/report-currency";
import type { ReportingConfig } from "@/lib/reporting-store";

export async function runReportingSync(
  config: ReportingConfig,
  input: {
    since: string;
    until: string;
    lifecycleStartDate?: string;
  },
) {
  if (!input.since || !input.until) throw new Error("Reporting sync period is required.");
  if (input.since > input.until) throw new Error("Reporting sync start date cannot be after end date.");

  // One shared lifecycle for scheduler/manual/Telegram:
  // 1) make sure the required weekly/monthly sheets exist;
  // 2) apply project currency to newly-created sheets;
  // 3) pull Meta day-by-day and write only mapped reporting channels.
  let lifecycle: Awaited<ReturnType<typeof ensureProjectReportLifecycle>>;
  try {
    lifecycle = await ensureProjectReportLifecycle({
      spreadsheetId: config.report_file_id,
      projectName: config.project_name,
      goalKey: config.goal_key,
      goalLabel: config.goal_label,
      reportingStartDate: input.lifecycleStartDate || config.report_start_date,
    });
  } catch (error) {
    throw new Error(`Підготовка вкладок Google Sheets: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (lifecycle.created.length) {
    try {
      await applyReportCurrencyFormats(config.report_file_id, config.currency || "USD");
    } catch (error) {
      throw new Error(`Форматування валюти Google Sheets: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let result: Awaited<ReturnType<typeof syncMetaReporting>>;
  try {
    result = await syncMetaReporting({
      accountId: config.meta_account_id,
      spreadsheetId: config.report_file_id,
      since: input.since,
      until: input.until,
      currency: config.currency || "USD",
    });
  } catch (error) {
    throw new Error(`Імпорт Meta Ads → Google Sheets: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { lifecycle, result };
}
