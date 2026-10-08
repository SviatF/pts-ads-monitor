import { PTS_REPORT_TEMPLATE, dailyBlocksForDays } from "@/lib/report-template";
import { applyReportFormulas } from "@/lib/report-formulas";
import {
  addMonths,
  endOfMonth,
  fourPeriodsForMonth,
  monthKey,
  parseIsoDate,
  periodForDate,
  periodLength,
  startOfMonth,
  type ReportPeriod,
} from "@/lib/report-periods";

type GoalPreset = { key: string; label: string; columnLabel: string; focusLabel: string };
type SheetMeta = { properties: { sheetId: number; title: string; hidden?: boolean; index?: number } };

export const REPORTING_GOALS: GoalPreset[] = [
  { key: "sale", label: "Продаж", columnLabel: "Продаж", focusLabel: "продаж" },
  { key: "registration", label: "Реєстрація", columnLabel: "Реєстрації", focusLabel: "реєстрація" },
  { key: "prepayment", label: "Аванс", columnLabel: "Аванси", focusLabel: "аванс" },
  { key: "booking", label: "Бронювання", columnLabel: "Бронювання", focusLabel: "бронювання" },
  { key: "appointment", label: "Запис", columnLabel: "Записи", focusLabel: "запис" },
  { key: "ftd", label: "FTD", columnLabel: "FTD", focusLabel: "FTD" },
  { key: "other", label: "Інше", columnLabel: "Ціль", focusLabel: "ціль" },
];

const MASTER_SHEET_TITLE = "_PTS_MASTER";
let tokenCache: { token: string; expiresAt: number } | null = null;

function googleConfig() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const templateFileId = process.env.GOOGLE_REPORT_TEMPLATE_FILE_ID;
  const reportsFolderId = process.env.GOOGLE_REPORTS_FOLDER_ID;
  if (!clientEmail || !privateKey || !templateFileId) {
    throw new Error("Google reporting is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY and GOOGLE_REPORT_TEMPLATE_FILE_ID.");
  }
  return { clientEmail, privateKey, templateFileId, reportsFolderId };
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function stringToBase64Url(value: string) { return bytesToBase64Url(new TextEncoder().encode(value)); }
function pemToArrayBuffer(pem: string) {
  const clean = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const { clientEmail, privateKey } = googleConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = stringToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = stringToBase64Url(JSON.stringify({ iss: clientEmail, scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function googleJson<T>(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}
async function googleNoContent(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
}

function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function addDays(date: Date, days: number) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + days); return next; }
function formatUaDate(date: Date) { return new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(date); }
function escapeSheetTitle(title: string) { return title.replace(/'/g, "''"); }
function quoteSheet(title: string) { return `'${escapeSheetTitle(title)}'`; }

function goalLabels(goalKey: string, customGoal?: string) {
  const preset = REPORTING_GOALS.find((goal) => goal.key === goalKey) || REPORTING_GOALS[0];
  const custom = customGoal?.trim();
  return { column: preset.key === "other" && custom ? custom : preset.columnLabel, focus: preset.key === "other" && custom ? custom.toLowerCase() : preset.focusLabel };
}

async function getSheets(spreadsheetId: string) {
  const metadata = await googleJson<{ sheets: SheetMeta[] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title,hidden,index)`);
  return metadata.sheets || [];
}
async function batchUpdateSpreadsheet(spreadsheetId: string, requests: unknown[]) {
  if (!requests.length) return;
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}
async function valuesBatchUpdate(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<string | number>> }>) {
  if (!data.length) return;
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }) });
}
async function clearRanges(spreadsheetId: string, ranges: string[]) {
  if (!ranges.length) return;
  await googleNoContent(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`, { method: "POST", body: JSON.stringify({ ranges }) });
}

async function ensureMasterSheet(spreadsheetId: string) {
  const sheets = await getSheets(spreadsheetId);
  const master = sheets.find((sheet) => sheet.properties.title === MASTER_SHEET_TITLE);
  if (master) return master.properties.sheetId;
  const source = sheets[0];
  if (!source) throw new Error("Project report has no worksheet");
  await batchUpdateSpreadsheet(spreadsheetId, [{ updateSheetProperties: { properties: { sheetId: source.properties.sheetId, title: MASTER_SHEET_TITLE }, fields: "title" } }]);
  return source.properties.sheetId;
}
async function hideMasterSheet(spreadsheetId: string, masterSheetId: number) {
  const sheets = await getSheets(spreadsheetId);
  const master = sheets.find((sheet) => sheet.properties.sheetId === masterSheetId);
  const visibleOthers = sheets.some((sheet) => sheet.properties.sheetId !== masterSheetId && !sheet.properties.hidden);
  if (!master || master.properties.hidden || !visibleOthers) return;
  await batchUpdateSpreadsheet(spreadsheetId, [{ updateSheetProperties: { properties: { sheetId: masterSheetId, hidden: true }, fields: "hidden" } }]);
}

async function duplicateFromMaster(spreadsheetId: string, masterSheetId: number, title: string) {
  const response = await googleJson<{ replies?: Array<{ duplicateSheet?: { properties?: { sheetId?: number } } }> }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ duplicateSheet: { sourceSheetId: masterSheetId, newSheetName: title } }] }) });
  const id = response.replies?.[0]?.duplicateSheet?.properties?.sheetId;
  if (typeof id !== "number") throw new Error(`Could not create worksheet ${title}`);

  // _PTS_MASTER is intentionally hidden. Google copies that hidden flag when
  // duplicating the sheet, so explicitly make every generated report tab visible.
  await batchUpdateSpreadsheet(spreadsheetId, [{
    updateSheetProperties: {
      properties: { sheetId: id, hidden: false },
      fields: "hidden",
    },
  }]);

  return id;
}

async function expandWeeklySheet(spreadsheetId: string, sheetId: number, days: number) {
  const extra = Math.max(0, days - 7);
  if (!extra) return;
  const requests: unknown[] = [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: 168, endIndex: 168 + extra * 20 }, inheritFromBefore: false } }];
  for (let index = 0; index < extra; index += 1) {
    const destinationStart = 169 + index * 20;
    requests.push({ copyPaste: { source: { sheetId, startRowIndex: 149, endRowIndex: 168, startColumnIndex: 0, endColumnIndex: 18 }, destination: { sheetId, startRowIndex: destinationStart, endRowIndex: destinationStart + 19, startColumnIndex: 0, endColumnIndex: 18 }, pasteType: "PASTE_NORMAL", pasteOrientation: "NORMAL" } });
  }
  await batchUpdateSpreadsheet(spreadsheetId, requests);
}

function templateDataRanges(sheetTitle: string, days = 7) {
  const sheet = quoteSheet(sheetTitle);
  return [
    `${sheet}!B${PTS_REPORT_TEMPLATE.weekly.dataStartRow}:R${PTS_REPORT_TEMPLATE.weekly.dataEndRow}`,
    ...dailyBlocksForDays(days).map((block) => `${sheet}!B${block.dataStartRow}:R${block.dataEndRow}`),
  ];
}

function commonSheetValues(sheetTitle: string, projectName: string, start: Date, end: Date, goalColumn: string, goalFocus: string, days = 7) {
  const sheet = quoteSheet(sheetTitle);
  const headerRows = [PTS_REPORT_TEMPLATE.weekly.headerRow, ...dailyBlocksForDays(days).map((block) => block.headerRow)];
  const data: Array<{ range: string; values: string[][] }> = [
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.titleCell}`, values: [[`${projectName} × PTS | PERFORMANCE REPORT`]] },
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.periodStartCell}`, values: [[formatUaDate(start)]] },
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.periodEndCell}`, values: [[formatUaDate(end)]] },
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.focusCell}`, values: [[`Фокус: Цільовий лід → A-лід → проведена зустріч → ${goalFocus}`]] },
  ];
  for (const row of headerRows) {
    data.push({ range: `${sheet}!B${row}`, values: [["Загальна\nкількість лідів"]] });
    data.push({ range: `${sheet}!C${row}`, values: [["Результат"]] });
    data.push({ range: `${sheet}!D${row}`, values: [["% різниці між\nрезультатом та\nлідами"]] });
    data.push({ range: `${sheet}!O${row}`, values: [[goalColumn]] });
    data.push({ range: `${sheet}!P${row}`, values: [[`Конверсія\nЗ → ${goalFocus}`]] });
  }
  return data;
}

async function createWeeklySheet(input: { spreadsheetId: string; masterSheetId: number; projectName: string; period: ReportPeriod; goalColumn: string; goalFocus: string }) {
  const { spreadsheetId, masterSheetId, projectName, period, goalColumn, goalFocus } = input;
  const days = periodLength(period);
  const sheetId = await duplicateFromMaster(spreadsheetId, masterSheetId, period.title);
  await expandWeeklySheet(spreadsheetId, sheetId, days);
  await clearRanges(spreadsheetId, templateDataRanges(period.title, days));
  const sheet = quoteSheet(period.title);
  const data = commonSheetValues(period.title, projectName, period.start, period.end, goalColumn, goalFocus, days);
  dailyBlocksForDays(days).forEach((block, index) => {
    const date = addDays(period.start, index);
    data.push({ range: `${sheet}!A${block.dateRow}`, values: [[formatUaDate(date)]] });
  });
  await valuesBatchUpdate(spreadsheetId, data);
}

function cellFormulaForMonthly(column: string, row: number, weeklyTitles: string[]) {
  const refs = weeklyTitles.map((title) => `${quoteSheet(title)}!${column}${row}`);
  const sumColumns = new Set(["B", "C", "E", "G", "H", "J", "L", "M", "O"]);
  if (sumColumns.has(column)) return `=SUM(${refs.join(";")})`;
  switch (column) {
    case "D": return `=IFERROR(1-B${row}/C${row};0)`;
    case "F": return `=IFERROR(E${row}/B${row};0)`;
    case "I": return `=IFERROR(H${row}/B${row};0)`;
    case "K": return `=IFERROR(J${row}/G${row};0)`;
    case "N": return `=IFERROR(L${row}/J${row};0)`;
    case "P": return `=IFERROR(O${row}/M${row};0)`;
    case "Q": return `=IFERROR(E${row}/J${row};0)`;
    case "R": return `=IFERROR(E${row}/M${row};0)`;
    default: return refs[0] ? `=${refs[0]}` : "";
  }
}

async function writeMonthlySheet(input: { spreadsheetId: string; projectName: string; month: Date; weeklyPeriods: ReportPeriod[]; goalColumn: string; goalFocus: string }) {
  const { spreadsheetId, projectName, month, weeklyPeriods, goalColumn, goalFocus } = input;
  const title = `МІСЯЦЬ ${monthKey(month)}`;
  const monthEnd = endOfMonth(month);
  const sheet = quoteSheet(title);
  const data = commonSheetValues(title, projectName, startOfMonth(month), monthEnd, goalColumn, goalFocus);
  data.push({ range: `${sheet}!A${PTS_REPORT_TEMPLATE.weekly.titleRow}`, values: [["МІСЯЧНА PERFORMANCE-ЗВІТНІСТЬ"]] });
  data.push({ range: `${sheet}!A${PTS_REPORT_TEMPLATE.daily.sectionTitleRow}`, values: [["ТИЖНЕВА ЗВІТНІСТЬ"]] });

  // Monthly report contract:
  // - top block = formulas summing all available weekly sheets of that month;
  // - first four lower blocks = one-to-one mirrors of 01–07, 08–15, 16–22, 23–month-end.
  // This function is intentionally idempotent so lifecycle can refresh an already
  // existing monthly sheet when the next weekly sheet appears.
  const weeklyTitles = weeklyPeriods.map((period) => period.title);
  const columns = "ABCDEFGHIJKLMNOPQR".split("");

  if (weeklyTitles.length) {
    for (let row = PTS_REPORT_TEMPLATE.weekly.dataStartRow; row <= PTS_REPORT_TEMPLATE.weekly.dataEndRow; row += 1) {
      for (const column of columns) {
        data.push({
          range: `${sheet}!${column}${row}`,
          values: [[column === "A" ? `=${quoteSheet(weeklyTitles[0])}!A${row}` : cellFormulaForMonthly(column, row, weeklyTitles)]],
        });
      }
    }
  }

  const monthlyBlocks = PTS_REPORT_TEMPLATE.daily.blocks.slice(0, 4);
  monthlyBlocks.forEach((block, index) => {
    const period = weeklyPeriods[index];
    if (!period) {
      data.push({ range: `${sheet}!A${block.dateRow}`, values: [[""]] });
      return;
    }

    data.push({ range: `${sheet}!A${block.dateRow}`, values: [[period.title]] });
    for (let sourceRow = PTS_REPORT_TEMPLATE.weekly.dataStartRow; sourceRow <= PTS_REPORT_TEMPLATE.weekly.dataEndRow; sourceRow += 1) {
      const targetRow = block.dataStartRow + (sourceRow - PTS_REPORT_TEMPLATE.weekly.dataStartRow);
      for (const column of columns) {
        data.push({
          range: `${sheet}!${column}${targetRow}`,
          values: [[`=${quoteSheet(period.title)}!${column}${sourceRow}`]],
        });
      }
    }
  });

  await valuesBatchUpdate(spreadsheetId, data);
}

async function createMonthlySheet(input: { spreadsheetId: string; masterSheetId: number; projectName: string; month: Date; weeklyPeriods: ReportPeriod[]; goalColumn: string; goalFocus: string }) {
  const { spreadsheetId, masterSheetId, projectName, month, weeklyPeriods, goalColumn, goalFocus } = input;
  const title = `МІСЯЦЬ ${monthKey(month)}`;
  await duplicateFromMaster(spreadsheetId, masterSheetId, title);
  await clearRanges(spreadsheetId, templateDataRanges(title));
  await writeMonthlySheet({ spreadsheetId, projectName, month, weeklyPeriods, goalColumn, goalFocus });
}

function kyivCalendarDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
  ));
}

export async function getExistingReportingCoverage(spreadsheetId: string, now = new Date()) {
  const titles = new Set((await getSheets(spreadsheetId)).map((sheet) => sheet.properties.title));
  const today = kyivCalendarDate(now);
  const currentMonth = startOfMonth(today);
  let month = addMonths(currentMonth, -18);
  let earliest: Date | null = null;
  let latest: Date | null = null;
  const weeklyTitles: string[] = [];

  while (month <= currentMonth) {
    for (const period of fourPeriodsForMonth(month)) {
      if (!titles.has(period.title)) continue;
      weeklyTitles.push(period.title);
      if (!earliest || period.start < earliest) earliest = period.start;
      if (!latest || period.end > latest) latest = period.end;
    }
    month = addMonths(month, 1);
  }

  return {
    since: earliest ? isoDate(earliest) : null,
    until: latest ? isoDate(latest) : null,
    weeklyTitles,
  };
}

export async function ensureProjectReportLifecycle(input: { spreadsheetId: string; projectName: string; goalKey: string; goalLabel?: string; customGoal?: string; reportingStartDate: string; now?: Date }) {
  const now = input.now || new Date();
  // Reporting periods are business-calendar periods in Europe/Kyiv.
  const today = kyivCalendarDate(now);
  const reportingStart = parseIsoDate(input.reportingStartDate);
  const labels = goalLabels(input.goalKey, input.customGoal || input.goalLabel);

  // One metadata read for the whole lifecycle pass. The previous implementation
  // re-read spreadsheet metadata 4 times per sync, which could exhaust Google's
  // 60 read requests/min/user quota when many projects ran together.
  const sheets = await getSheets(input.spreadsheetId);
  if (!sheets.length) throw new Error("Project report has no worksheet");

  let master = sheets.find((sheet) => sheet.properties.title === MASTER_SHEET_TITLE);
  if (!master) {
    master = sheets[0];
    await batchUpdateSpreadsheet(input.spreadsheetId, [{
      updateSheetProperties: {
        properties: { sheetId: master.properties.sheetId, title: MASTER_SHEET_TITLE },
        fields: "title",
      },
    }]);
    master.properties.title = MASTER_SHEET_TITLE;
  }
  const masterSheetId = master.properties.sheetId;

  const existing = new Set(sheets.map((sheet) => sheet.properties.title));
  const created: string[] = [];

  // Repair sheets created by older lifecycle versions that inherited hidden=true
  // from the hidden _PTS_MASTER template.
  const hiddenGeneratedSheets = sheets.filter(
    (sheet) => sheet.properties.title !== MASTER_SHEET_TITLE && sheet.properties.hidden,
  );
  if (hiddenGeneratedSheets.length) {
    await batchUpdateSpreadsheet(
      input.spreadsheetId,
      hiddenGeneratedSheets.map((sheet) => ({
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, hidden: false },
          fields: "hidden",
        },
      })),
    );
    for (const sheet of hiddenGeneratedSheets) sheet.properties.hidden = false;
  }

  let month = startOfMonth(reportingStart);
  const currentMonth = startOfMonth(today);
  while (month <= currentMonth) {
    const periods = fourPeriodsForMonth(month);
    for (const period of periods) {
      if (period.start > today || period.end < reportingStart) continue;
      if (!existing.has(period.title)) {
        await createWeeklySheet({
          spreadsheetId: input.spreadsheetId,
          masterSheetId,
          projectName: input.projectName,
          period,
          goalColumn: labels.column,
          goalFocus: labels.focus,
        });
        existing.add(period.title);
        created.push(period.title);
      }
    }

    const monthlyTitle = `МІСЯЦЬ ${monthKey(month)}`;
    // Use the weekly sheets that actually exist in the workbook. Do not filter
    // them by reportingStartDate: older projects can have valid weekly tabs that
    // pre-date the config row, and excluding them is exactly what caused monthly
    // reports to mirror only the final week.
    const availablePeriods = periods.filter((period) => existing.has(period.title));

    if (availablePeriods.length) {
      if (!existing.has(monthlyTitle)) {
        await createMonthlySheet({
          spreadsheetId: input.spreadsheetId,
          masterSheetId,
          projectName: input.projectName,
          month,
          weeklyPeriods: availablePeriods,
          goalColumn: labels.column,
          goalFocus: labels.focus,
        });
        existing.add(monthlyTitle);
        created.push(monthlyTitle);
      } else {
        // Refresh formulas every lifecycle pass so when week 2/3/4 appears the
        // monthly top block and the corresponding lower weekly block pick it up.
        await writeMonthlySheet({
          spreadsheetId: input.spreadsheetId,
          projectName: input.projectName,
          month,
          weeklyPeriods: availablePeriods,
          goalColumn: labels.column,
          goalFocus: labels.focus,
        });
      }
    }
    month = addMonths(month, 1);
  }

  // Hide the master without another metadata read.
  const visibleOthers = existing.size > 1;
  if (!master.properties.hidden && visibleOthers) {
    await batchUpdateSpreadsheet(input.spreadsheetId, [{
      updateSheetProperties: {
        properties: { sheetId: masterSheetId, hidden: true },
        fields: "hidden",
      },
    }]);
    master.properties.hidden = true;
  }

  return {
    created,
    visibleSheets: Math.max(0, existing.size - (existing.has(MASTER_SHEET_TITLE) ? 1 : 0)),
  };
}

export async function createProjectReport(input: { projectName: string; goalKey: string; customGoal?: string; startDate: string }) {
  const cfg = googleConfig();
  const labels = goalLabels(input.goalKey, input.customGoal);
  const fileName = `${input.projectName} × PTS | PERFORMANCE REPORT`;
  const copied = await googleJson<{ id: string; name: string; webViewLink?: string }>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cfg.templateFileId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`, { method: "POST", body: JSON.stringify({ name: fileName, ...(cfg.reportsFolderId ? { parents: [cfg.reportsFolderId] } : {}) }) });
  await ensureProjectReportLifecycle({ spreadsheetId: copied.id, projectName: input.projectName, goalKey: input.goalKey, customGoal: input.customGoal, reportingStartDate: input.startDate });
  // A newly created report must be usable immediately, not only after the next
  // scheduled lifecycle/morning sync.
  await applyReportFormulas(copied.id);
  const start = parseIsoDate(input.startDate);
  const initialPeriod = periodForDate(start);
  return { fileId: copied.id, url: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`, goalLabel: labels.column, startDate: input.startDate, endDate: isoDate(initialPeriod.end) };
}
