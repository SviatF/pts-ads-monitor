import { NextResponse } from "next/server";
import { getReportingConfig } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle, getExistingReportingCoverage } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import {
  finishReportingRepairJob,
  getReportingRepairSummary,
  incrementReportingRepairAttempt,
  listPendingReportingRepairJobs,
} from "@/lib/reporting-repair-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function kyivDateIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftIsoDay(iso: string, delta: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isGoogleSheetsRateLimit(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("google api failed (429)") ||
    message.includes("resource_exhausted") ||
    message.includes("rate_limit_exceeded") ||
    message.includes("read requests per minute per user")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withQuotaRetry<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!isGoogleSheetsRateLimit(error)) throw error;
    await sleep(65_000);
    return await operation();
  }
}

async function notifyAdmin(text: string) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  try {
    await sendTelegramToChat(chatId, text);
  } catch (error) {
    console.error("Reporting repair admin notification failed", error);
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 2);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 3)) : 2;
  const jobs = await listPendingReportingRepairJobs(limit);
  const today = kyivDateIso();
  const until = shiftIsoDay(today, -1);
  const results: Array<Record<string, unknown>> = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (index > 0) await sleep(8000);

    await incrementReportingRepairAttempt(job.id, job.attempts);

    try {
      const config = await getReportingConfig(job.meta_account_id);
      if (!config || config.status !== "configured" || !config.report_file_id || config.report_file_id === "MONITOR_ONLY") {
        await finishReportingRepairJob(job.id, {
          status: "failed",
          error: "Configured reporting project was not found.",
        });
        results.push({ project: job.project_name, status: "failed", error: "config missing" });
        continue;
      }

      const repaired = await withQuotaRetry(async () => {
        await ensureProjectReportLifecycle({
          spreadsheetId: config.report_file_id,
          projectName: config.project_name,
          goalKey: config.goal_key,
          goalLabel: config.goal_label,
          reportingStartDate: config.report_start_date,
        });

        // Existing reports can contain weekly tabs older than reporting_configs.report_start_date
        // (many September projects were configured on 30.09 after earlier tabs already existed).
        // Repair from the earliest real weekly tab, not blindly from the config date.
        const coverage = await getExistingReportingCoverage(config.report_file_id);
        const since = coverage.since || config.report_start_date;

        if (since > until) {
          return {
            since,
            result: null,
            coverage,
          };
        }

        const result = await syncMetaReporting({
          accountId: config.meta_account_id,
          spreadsheetId: config.report_file_id,
          since,
          until,
          currency: config.currency || "USD",
        });

        return { since, result, coverage };
      });

      if (!repaired.result) {
        await finishReportingRepairJob(job.id, {
          status: "healthy",
          repairFrom: repaired.since,
          repairTo: until,
          expectedSpend: 0,
          expectedResults: 0,
          verifiedSpend: 0,
          verifiedResults: 0,
        });
        results.push({ project: job.project_name, status: "healthy", note: "no historical days to repair" });
        continue;
      }

      const result = repaired.result;
      const verifiedSpend = result.verification.reduce((sum, item) => sum + item.actualSpend, 0);
      const verifiedResults = result.verification.reduce((sum, item) => sum + item.actualResults, 0);
      const hasUnmappedSpend = result.unmappedSpend > 0.02;
      const healthy = result.verificationOk && !hasUnmappedSpend;

      const mismatchDetails = {
        periodVerification: result.verification.filter((item) => !item.matches),
        unmappedCampaigns: result.unmappedCampaigns,
        unmappedSpend: result.unmappedSpend,
        unmappedResults: result.unmappedResults,
        campaignSheets: result.campaignDetail,
      };

      await finishReportingRepairJob(job.id, {
        status: healthy ? "healthy" : "mismatch",
        repairFrom: repaired.since,
        repairTo: until,
        expectedSpend: result.mappedSpend,
        expectedResults: result.mappedLeads,
        verifiedSpend: Number(verifiedSpend.toFixed(2)),
        verifiedResults,
        mismatchDetails: healthy ? null : mismatchDetails,
      });

      results.push({
        project: job.project_name,
        status: healthy ? "healthy" : "mismatch",
        since: repaired.since,
        until,
        mappedSpend: result.mappedSpend,
        mappedResults: result.mappedLeads,
        unmappedSpend: result.unmappedSpend,
        unmappedCampaigns: result.unmappedCampaigns,
        verificationOk: result.verificationOk,
      });
    } catch (error) {
      const message = errorMessage(error);
      await finishReportingRepairJob(job.id, {
        status: "failed",
        error: message,
      });
      results.push({ project: job.project_name, status: "failed", error: message });
    }
  }

  const summary = await getReportingRepairSummary();
  const pendingRetryable = summary.rows.filter(
    (row) => (row.status === "pending" || row.status === "failed") && row.attempts < 3,
  );

  if (jobs.length > 0 && pendingRetryable.length === 0) {
    const healthy = summary.counts.healthy || 0;
    const mismatch = summary.counts.mismatch || 0;
    const failed = summary.counts.failed || 0;
    await notifyAdmin(
      `🧾 <b>PTS Reporting · повний аудит завершено</b>\n\n✅ Healthy: <b>${healthy}</b>\n⚠️ Mismatch: <b>${mismatch}</b>\n❌ Failed: <b>${failed}</b>\n\nMismatch означає або невідповідність Google Sheet ↔ Meta, або campaign з spend, який не вдалося безпечно замапити у Direct / Lead Form / Quiz / Site.`,
    );
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    results,
    summary: summary.counts,
    remainingRetryable: pendingRetryable.length,
  });
}
