import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { PTS_REPORT_TEMPLATE, dailyBlocksForDays } from "@/lib/report-template";
import { periodLengthFromTitle } from "@/lib/report-periods";

type SheetMeta = { properties: { title: string; hidden?: boolean } };
type ValueUpdate = { range: string; values: Array<Array<string | number>> };

// B = manager-entered actual/general leads.
// C = Meta Ads result/conversions imported automatically.
// Both are additive in group, weekly and monthly rollups.
const ADDITIVE_COLUMNS = ["B", "C", "E", "G", "H", "J", "L", "M", "O"] as const;
const GROUPS = [
  { rowOffset: 0, childStartOffset: 1, childEndOffset: 4 },
  { rowOffset: 5, childStartOffset: 6, childEndOffset: 9 },
  { rowOffset: 10, childStartOffset: 11, childEndOffset: 15 },
] as const;
const TOTAL_OFFSET = 16;

function quoteSheet(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

async function googleJson<T>(url: string, init: RequestInit = {}) {
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

async function valuesBatchUpdate(spreadsheetId: string, data: ValueUpdate[]) {
  if (!data.length) return;
  await googleJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );
}

function derivedFormulas(row: number) {
  return {
    // Difference between ad-platform Result (C) and manager-confirmed leads (B).
    // Example: Meta result 100, manager leads 90 => 10% difference.
    D: `=IFERROR(1-B${row}/C${row};0)`,
    // Cost per manager-confirmed/handed-off lead.
    F: `=IFERROR(E${row}/B${row};0)`,
    I: `=IFERROR(H${row}/B${row};0)`,
    K: `=IFERROR(J${row}/G${row};0)`,
    N: `=IFERROR(L${row}/J${row};0)`,
    P: `=IFERROR(O${row}/M${row};0)`,
    Q: `=IFERROR(E${row}/J${row};0)`,
    R: `=IFERROR(E${row}/M${row};0)`,
  } as const;
}

function pushDerived(data: ValueUpdate[], sheetTitle: string, row: number) {
  const sheet = quoteSheet(sheetTitle);
  for (const [column, formula] of Object.entries(derivedFormulas(row))) {
    data.push({ range: `${sheet}!${column}${row}`, values: [[formula]] });
  }
}

function pushGroup(data: ValueUpdate[], sheetTitle: string, groupRow: number, childStart: number, childEnd: number) {
  const sheet = quoteSheet(sheetTitle);
  for (const column of ADDITIVE_COLUMNS) {
    data.push({ range: `${sheet}!${column}${groupRow}`, values: [[`=SUM(${column}${childStart}:${column}${childEnd})`]] });
  }
  pushDerived(data, sheetTitle, groupRow);
}

function pushTotal(data: ValueUpdate[], sheetTitle: string, row: number, groupRows: number[]) {
  const sheet = quoteSheet(sheetTitle);
  for (const column of ADDITIVE_COLUMNS) {
    data.push({ range: `${sheet}!${column}${row}`, values: [[`=SUM(${groupRows.map((groupRow) => `${column}${groupRow}`).join(";")})`]] });
  }
  pushDerived(data, sheetTitle, row);
}

function addDailyBlockFormulas(data: ValueUpdate[], sheetTitle: string, dataStartRow: number) {
  const detailOffsets = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15];

  // IMPORTANT: B, G, H, J, L, M and O are manager-input cells on detail rows.
  // C and E are written by Meta sync. We never generate/overwrite B or C here.
  for (const offset of detailOffsets) {
    const row = dataStartRow + offset;
    pushDerived(data, sheetTitle, row);
  }

  for (const group of GROUPS) {
    pushGroup(data, sheetTitle, dataStartRow + group.rowOffset, dataStartRow + group.childStartOffset, dataStartRow + group.childEndOffset);
  }

  pushTotal(data, sheetTitle, dataStartRow + TOTAL_OFFSET, GROUPS.map((group) => dataStartRow + group.rowOffset));
}

function addWeeklyFormulas(data: ValueUpdate[], sheetTitle: string, dailyStarts: number[]) {
  const sheet = quoteSheet(sheetTitle);
  const weeklyStart = PTS_REPORT_TEMPLATE.weekly.dataStartRow;

  for (let offset = 0; offset <= TOTAL_OFFSET; offset += 1) {
    const row = weeklyStart + offset;
    for (const column of ADDITIVE_COLUMNS) {
      const refs = dailyStarts.map((start) => `${column}${start + offset}`);
      data.push({ range: `${sheet}!${column}${row}`, values: [[`=SUM(${refs.join(";")})`]] });
    }
    pushDerived(data, sheetTitle, row);
  }
}

function pushSchemaHeaders(data: ValueUpdate[], sheetTitle: string, days: number) {
  const sheet = quoteSheet(sheetTitle);
  const rows = [PTS_REPORT_TEMPLATE.weekly.headerRow, ...dailyBlocksForDays(days).map((block) => block.headerRow)];
  for (const row of rows) {
    data.push({ range: `${sheet}!B${row}`, values: [["Загальна\nкількість лідів"]] });
    data.push({ range: `${sheet}!C${row}`, values: [["Результат"]] });
    data.push({ range: `${sheet}!D${row}`, values: [["% різниці між\nрезультатом та\nлідами"]] });
  }
}

function isWeeklySheet(title: string) {
  return /^\d{2}\.\d{2}[–-]\d{2}\.\d{2}$/.test(title);
}

export async function applyReportFormulas(spreadsheetId: string) {
  const metadata = await googleJson<{ sheets?: SheetMeta[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,hidden)`,
  );

  const weeklySheets = (metadata.sheets || [])
    // Formula repair must not depend on visibility. Generated report tabs may
    // temporarily be hidden (or have been created hidden by an older lifecycle
    // version), but their formulas still need to be restored.
    .filter((sheet) => isWeeklySheet(sheet.properties.title))
    .map((sheet) => sheet.properties.title);

  const data: ValueUpdate[] = [];
  for (const title of weeklySheets) {
    const days = periodLengthFromTitle(title) || 7;
    const blocks = dailyBlocksForDays(days);
    pushSchemaHeaders(data, title, days);
    for (const block of blocks) addDailyBlockFormulas(data, title, block.dataStartRow);
    addWeeklyFormulas(data, title, blocks.map((block) => block.dataStartRow));
  }

  await valuesBatchUpdate(spreadsheetId, data);
  return { weeklySheets, formulaCellsUpdated: data.length };
}
