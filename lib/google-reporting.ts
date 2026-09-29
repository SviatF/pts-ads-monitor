import { PTS_REPORT_TEMPLATE } from "@/lib/report-template";

type GoalPreset = {
  key: string;
  label: string;
  columnLabel: string;
  focusLabel: string;
};

type SheetMeta = { properties: { sheetId: number; title: string; hidden?: boolean; index?: number } };

type Period = {
  start: Date;
  end: Date;
  title: string;
};

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
    throw new Error(
      "Google reporting is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY and GOOGLE_REPORT_TEMPLATE_FILE_ID.",
    );
  }

  return { clientEmail, privateKey, templateFileId, reportsFolderId };
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function stringToBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem: string) {
  const clean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
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
  const payload = stringToBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) throw new Error(`Google OAuth failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function googleJson<T>(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function googleNoContent(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatUaDate(date: Date) {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function shortDate(date: Date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthKey(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}.${date.getUTCFullYear()}`;
}

function escapeSheetTitle(title: string) {
  return title.replace(/'/g, "''");
}

function quoteSheet(title: string) {
  return `'${escapeSheetTitle(title)}'`;
}

function weekPeriodsForMonth(month: Date): Period[] {
  const last = endOfMonth(month).getUTCDate();
  const starts = [1, 8, 15, 22, 29].filter((day) => day <= last);
  return starts.map((day) => {
    const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day));
    const endDay = Math.min(day + 6, last);
    const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), endDay));
    return { start, end, title: `${shortDate(start)}–${shortDate(end)}` };
  });
}

function goalLabels(goalKey: string, customGoal?: string) {
  const preset = REPORTING_GOALS.find((goal) => goal.key === goalKey) || REPORTING_GOALS[0];
  const custom = customGoal?.trim();
  return {
    column: preset.key === "other" && custom ? custom : preset.columnLabel,
    focus: preset.key === "other" && custom ? custom.toLowerCase() : preset.focusLabel,
  };
}

async function getSheets(spreadsheetId: string) {
  const metadata = await googleJson<{ sheets: SheetMeta[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title,hidden,index)`,
  );
  return metadata.sheets || [];
}

async function batchUpdateSpreadsheet(spreadsheetId: string, requests: unknown[]) {
  if (!requests.length) return;
  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function valuesBatchUpdate(
  spreadsheetId: string,
  data: Array<{ range: string; values: Array<Array<string | number>> }>,
) {
  if (!data.length) return;
  await googleJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );
}

async function clearRanges(spreadsheetId: string, ranges: string[]) {
  if (!ranges.length) return;
  await googleNoContent(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    { method: "POST", body: JSON.stringify({ ranges }) },
  );
}

async function ensureMasterSheet(spreadsheetId: string) {
  const sheets = await getSheets(spreadsheetId);
  const master = sheets.find((sheet) => sheet.properties.title === MASTER_SHEET_TITLE);
  if (master) return master.properties.sheetId;

  const source = sheets[0];
  if (!source) throw new Error("Project report has no worksheet");

  // Google does not allow hiding the only visible sheet. Rename first, create the
  // first weekly sheet, and hide the master afterwards.
  await batchUpdateSpreadsheet(spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId: source.properties.sheetId, title: MASTER_SHEET_TITLE },
        fields: "title",
      },
    },
  ]);
  return source.properties.sheetId;
}

async function hideMasterSheet(spreadsheetId: string, masterSheetId: number) {
  const sheets = await getSheets(spreadsheetId);
  const master = sheets.find((sheet) => sheet.properties.sheetId === masterSheetId);
  const visibleOthers = sheets.some(
    (sheet) => sheet.properties.sheetId !== masterSheetId && !sheet.properties.hidden,
  );
  if (!master || master.properties.hidden || !visibleOthers) return;
  await batchUpdateSpreadsheet(spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId: masterSheetId, hidden: true },
        fields: "hidden",
      },
    },
  ]);
}

async function duplicateFromMaster(spreadsheetId: string, masterSheetId: number, title: string) {
  const response = await googleJson<{
    replies?: Array<{ duplicateSheet?: { properties?: { sheetId?: number; title?: string } } }>;
  }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          duplicateSheet: {
            sourceSheetId: masterSheetId,
            newSheetName: title,
          },
        },
      ],
    }),
  });
  const id = response.replies?.[0]?.duplicateSheet?.properties?.sheetId;
  if (typeof id !== "number") throw new Error(`Could not create worksheet ${title}`);
  return id;
}

function templateDataRanges(sheetTitle: string) {
  const sheet = quoteSheet(sheetTitle);
  // Column A is structural template data: source/funnel names such as Meta Ads,
  // Direct / Messenger, Lead Form, Quiz, Site, Google Ads and SMM. Never clear it.
  // Only metric/input columns B:R should be reset in newly duplicated sheets.
  return [
    `${sheet}!B${PTS_REPORT_TEMPLATE.weekly.dataStartRow}:R${PTS_REPORT_TEMPLATE.weekly.dataEndRow}`,
    ...PTS_REPORT_TEMPLATE.daily.blocks.map(
      (block) => `${sheet}!B${block.dataStartRow}:R${block.dataEndRow}`,
    ),
  ];
}

function commonSheetValues(sheetTitle: string, projectName: string, start: Date, end: Date, goalColumn: string, goalFocus: string) {
  const sheet = quoteSheet(sheetTitle);
  const headerRows = [
    PTS_REPORT_TEMPLATE.weekly.headerRow,
    ...PTS_REPORT_TEMPLATE.daily.blocks.map((block) => block.headerRow),
  ];
  const data: Array<{ range: string; values: string[][] }> = [
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.titleCell}`, values: [[`${projectName} × PTS | PERFORMANCE REPORT`]] },
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.periodStartCell}`, values: [[formatUaDate(start)]] },
    { range: `${sheet}!${PTS_REPORT_TEMPLATE.periodEndCell}`, values: [[formatUaDate(end)]] },
    {
      range: `${sheet}!${PTS_REPORT_TEMPLATE.focusCell}`,
      values: [[`Фокус: Цільовий лід → A-лід → проведена зустріч → ${goalFocus}`]],
    },
  ];

  for (const row of headerRows) {
    data.push({ range: `${sheet}!O${row}`, values: [[goalColumn]] });
    data.push({ range: `${sheet}!P${row}`, values: [[`Конверсія\nЗ → ${goalFocus}`]] });
  }
  return data;
}

async function createWeeklySheet(input: {
  spreadsheetId: string;
  masterSheetId: number;
  projectName: string;
  period: Period;
  goalColumn: string;
  goalFocus: string;
}) {
  const { spreadsheetId, masterSheetId, projectName, period, goalColumn, goalFocus } = input;
  await duplicateFromMaster(spreadsheetId, masterSheetId, period.title);
  await clearRanges(spreadsheetId, templateDataRanges(period.title));

  const sheet = quoteSheet(period.title);
  const data = commonSheetValues(period.title, projectName, period.start, period.end, goalColumn, goalFocus);
  PTS_REPORT_TEMPLATE.daily.blocks.forEach((block, index) => {
    const date = addDays(period.start, index);
    data.push({
      range: `${sheet}!A${block.dateRow}`,
      values: [[date <= period.end ? formatUaDate(date) : ""]],
    });
  });
  await valuesBatchUpdate(spreadsheetId, data);
}

function cellFormulaForMonthly(column: string, row: number, weeklyTitles: string[]) {
  const refs = weeklyTitles.map((title) => `${quoteSheet(title)}!${column}${row}`);
  const sumColumns = new Set(["B", "C", "E", "G", "H", "J", "L", "M", "O"]);
  if (sumColumns.has(column)) return `=SUM(${refs.join(",")})`;

  // Derived monthly KPIs are recalculated from monthly totals instead of averaging weekly rates.
  switch (column) {
    case "D": return `=IFERROR(1-C${row}/B${row},0)`;
    case "F": return `=IFERROR(E${row}/C${row},0)`;
    case "I": return `=IFERROR(H${row}/C${row},0)`;
    case "K": return `=IFERROR(J${row}/G${row},0)`;
    case "N": return `=IFERROR(M${row}/J${row},0)`;
    case "P": return `=IFERROR(O${row}/M${row},0)`;
    case "Q": return `=IFERROR(E${row}/J${row},0)`;
    case "R": return `=IFERROR(E${row}/M${row},0)`;
    default: return refs[0] ? `=${refs[0]}` : "";
  }
}

async function createMonthlySheet(input: {
  spreadsheetId: string;
  masterSheetId: number;
  projectName: string;
  month: Date;
  weeklyPeriods: Period[];
  goalColumn: string;
  goalFocus: string;
}) {
  const { spreadsheetId, masterSheetId, projectName, month, weeklyPeriods, goalColumn, goalFocus } = input;
  const title = `МІСЯЦЬ ${monthKey(month)}`;
  const monthEnd = endOfMonth(month);
  await duplicateFromMaster(spreadsheetId, masterSheetId, title);
  await clearRanges(spreadsheetId, templateDataRanges(title));

  const sheet = quoteSheet(title);
  const data = commonSheetValues(title, projectName, startOfMonth(month), monthEnd, goalColumn, goalFocus);
  data.push({ range: `${sheet}!A${PTS_REPORT_TEMPLATE.weekly.titleRow}`, values: [["МІСЯЧНА PERFORMANCE-ЗВІТНІСТЬ"]] });
  data.push({ range: `${sheet}!A${PTS_REPORT_TEMPLATE.daily.sectionTitleRow}`, values: [["ТИЖНЕВА ЗВІТНІСТЬ"]] });

  const weeklyTitles = weeklyPeriods.map((period) => period.title);
  const columns = "ABCDEFGHIJKLMNOPQR".split("");
  for (let row = PTS_REPORT_TEMPLATE.weekly.dataStartRow; row <= PTS_REPORT_TEMPLATE.weekly.dataEndRow; row += 1) {
    for (const column of columns) {
      if (column === "A") {
        data.push({ range: `${sheet}!A${row}`, values: [[`=${quoteSheet(weeklyTitles[0])}!A${row}`]] });
      } else {
        data.push({ range: `${sheet}!${column}${row}`, values: [[cellFormulaForMonthly(column, row, weeklyTitles)]] });
      }
    }
  }

  PTS_REPORT_TEMPLATE.daily.blocks.forEach((block, index) => {
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

export async function ensureProjectReportLifecycle(input: {
  spreadsheetId: string;
  projectName: string;
  goalKey: string;
  goalLabel?: string;
  customGoal?: string;
  reportingStartDate: string;
  now?: Date;
}) {
  const now = input.now || new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const reportingStart = parseIsoDate(input.reportingStartDate);
  const labels = goalLabels(input.goalKey, input.customGoal || input.goalLabel);
  const masterSheetId = await ensureMasterSheet(input.spreadsheetId);
  let sheets = await getSheets(input.spreadsheetId);
  const existing = new Set(sheets.map((sheet) => sheet.properties.title));
  const created: string[] = [];

  let month = startOfMonth(reportingStart);
  const currentMonth = startOfMonth(today);
  while (month <= currentMonth) {
    const periods = weekPeriodsForMonth(month);
    for (const period of periods) {
      if (period.start > today) continue;
      if (period.end < reportingStart) continue;
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

    const isClosedMonth = endOfMonth(month) < today;
    const monthlyTitle = `МІСЯЦЬ ${monthKey(month)}`;
    const availablePeriods = periods.filter((period) => period.end >= reportingStart);
    const allWeeklyExist = availablePeriods.every((period) => existing.has(period.title));
    if (isClosedMonth && allWeeklyExist && !existing.has(monthlyTitle)) {
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
    }

    month = addMonths(month, 1);
  }

  await hideMasterSheet(input.spreadsheetId, masterSheetId);
  sheets = await getSheets(input.spreadsheetId);
  const visibleSheets = sheets.filter((sheet) => !sheet.properties.hidden).length;
  return { created, visibleSheets };
}

export async function createProjectReport(input: {
  projectName: string;
  goalKey: string;
  customGoal?: string;
  startDate: string;
}) {
  const cfg = googleConfig();
  const labels = goalLabels(input.goalKey, input.customGoal);
  const fileName = `${input.projectName} × PTS | PERFORMANCE REPORT`;

  // One Google spreadsheet = one project. It is copied once from the immutable PTS master.
  const copied = await googleJson<{ id: string; name: string; webViewLink?: string }>(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cfg.templateFileId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: "POST",
      body: JSON.stringify({
        name: fileName,
        ...(cfg.reportsFolderId ? { parents: [cfg.reportsFolderId] } : {}),
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

  const start = parseIsoDate(input.startDate);
  const initialPeriod = weekPeriodsForMonth(start).find((period) => start >= period.start && start <= period.end) || {
    start,
    end: addDays(start, 6),
    title: `${shortDate(start)}–${shortDate(addDays(start, 6))}`,
  };

  return {
    fileId: copied.id,
    url: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    goalLabel: labels.column,
    startDate: input.startDate,
    endDate: isoDate(initialPeriod.end),
  };
}