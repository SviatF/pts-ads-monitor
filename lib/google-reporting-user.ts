import { ensureProjectReportLifecycle, createProjectReport as createWithServiceAccount, REPORTING_GOALS } from "@/lib/google-reporting";
import { getGoogleUserAccessToken, hasGoogleUserOAuth } from "@/lib/google-oauth";
import { applyReportFormulas } from "@/lib/report-formulas";

export { REPORTING_GOALS };

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function weekEndForDate(date: Date) {
  const day = date.getUTCDate();
  const startDay = day <= 7 ? 1 : day <= 14 ? 8 : day <= 21 ? 15 : day <= 28 ? 22 : 29;
  const endDay = Math.min(startDay + 6, endOfMonth(date).getUTCDate());
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), endDay));
}

function goalLabel(goalKey: string, customGoal?: string) {
  const preset = REPORTING_GOALS.find((goal) => goal.key === goalKey) || REPORTING_GOALS[0];
  const custom = customGoal?.trim();
  return preset.key === "other" && custom ? custom : preset.columnLabel;
}

async function googleUserJson<T>(url: string, init: RequestInit = {}) {
  const token = await getGoogleUserAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function createProjectReport(input: {
  projectName: string;
  goalKey: string;
  customGoal?: string;
  startDate: string;
}) {
  if (!hasGoogleUserOAuth()) return createWithServiceAccount(input);

  const templateFileId = process.env.GOOGLE_REPORT_TEMPLATE_FILE_ID;
  const reportsFolderId = process.env.GOOGLE_REPORTS_FOLDER_ID;
  if (!templateFileId) throw new Error("GOOGLE_REPORT_TEMPLATE_FILE_ID is missing.");

  const fileName = `${input.projectName} × PTS | PERFORMANCE REPORT`;
  const copied = await googleUserJson<{ id: string; name: string; webViewLink?: string }>(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateFileId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: "POST",
      body: JSON.stringify({
        name: fileName,
        ...(reportsFolderId ? { parents: [reportsFolderId] } : {}),
      }),
    },
  );

  await ensureProjectReportLifecycle({
    spreadsheetId: copied.id,
    projectName: input.projectName,
    goalKey: input.goalKey,
    customGoal: input.customGoal,
    reportingStartDate: input.startDate,
  });
  await applyReportFormulas(copied.id);

  const start = parseIsoDate(input.startDate);
  return {
    fileId: copied.id,
    url: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    goalLabel: goalLabel(input.goalKey, input.customGoal),
    startDate: input.startDate,
    endDate: weekEndForDate(start).toISOString().slice(0, 10),
  };
}
