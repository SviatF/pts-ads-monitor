import { listReportingConfigs } from "@/lib/reporting-store";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";
import { sendPerformanceMessage } from "@/lib/performance-telegram";

function kyivDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const key = `${map.year}-${map.month}-${map.day}`;
  return { key, date: new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))) };
}

function quoteSheet(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

function isBlank(value: unknown) {
  return value == null || String(value).trim() === "";
}

async function readTodayRows(spreadsheetId: string, range: string, token: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheets ${response.status}: ${text}`);
  const body = text ? JSON.parse(text) as { values?: unknown[][] } : {};
  return body.values || [];
}

export async function sendSalesReportingCompleteness() {
  const { key: todayKey, date: today } = kyivDate();
  const configs = (await listReportingConfigs()).filter((config) =>
    config.status === "configured" &&
    config.report_file_id &&
    config.report_file_id !== "MONITOR_ONLY" &&
    todayKey >= config.report_start_date &&
    todayKey <= config.report_end_date
  );

  if (!configs.length) return { checked: 0, missing: 0, projects: [] as string[] };

  const period = periodForDate(today);
  const block = dailyBlocksForDays(periodLength(period))[dayIndexInPeriod(today, period)];
  if (!block) return { checked: 0, missing: 0, projects: [] as string[] };

  const range = `${quoteSheet(period.title)}!A${block.dataStartRow}:O${block.dataEndRow}`;
  const token = await getGoogleUserAccessToken();
  const missing: string[] = [];
  const errors: string[] = [];

  // Manual sales/manager fields: B, G, H, J, L, M, O.
  // Numeric zero counts as filled; only truly empty cells are treated as missing.
  const manualIndexes = [1, 6, 7, 9, 11, 12, 14];

  for (const config of configs) {
    try {
      const rows = await readTodayRows(config.report_file_id, range, token);
      const sourceRows = rows.filter((row) => !isBlank(row[0]));
      const rowsToCheck = sourceRows.length ? sourceRows : rows;
      const hasAnyManualSalesData = rowsToCheck.some((row) => manualIndexes.some((index) => !isBlank(row[index])));
      if (!hasAnyManualSalesData) missing.push(config.project_name);
    } catch (error) {
      errors.push(`${config.project_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (missing.length) {
    await sendPerformanceMessage(
      `📝 <b>SALES DATA / НЕ ЗАПОВНЕНО</b>\n` +
      `На кінець дня немає даних від відділу продажів:\n` +
      missing.map((project) => `• <b>${escapeTelegramHtml(project)}</b>`).join("\n")
    );
  } else if (!errors.length) {
    await sendPerformanceMessage("✅ <b>SALES DATA</b> · по всіх активних звітах дані від відділу продажів заповнені.");
  }

  return { checked: configs.length, missing: missing.length, projects: missing, errors };
}
