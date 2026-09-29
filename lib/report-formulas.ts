import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { PTS_REPORT_TEMPLATE } from "@/lib/report-template";

type SheetMeta = { properties: { title: string; hidden?: boolean } };
type ValueUpdate = { range: string; values: Array<Array<string | number>> };

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

// PTS master uses a Ukrainian/European spreadsheet locale, therefore
// Google Sheets formula function arguments must be separated with semicolons.
// Using commas causes #ERROR! / "Formula parse error" in copied reports.
function derivedFormulas(row: number) {
  return {
    D: `=IFERROR(1-C${row}/B${row};0)`,
    F: `=IFERROR(E${row}/C${row};0)`,
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
  const formulas = derivedFormulas(row);
  for (const [column, formula] of Object.entries(formulas)) {
    data.push({ range: `${sheet}!${column}${row}`, values: [[formula]] });
  }
}

function pushGroup(data: ValueUpdate[], sheetTitle: string, groupRow: number, childStart: number, childEnd: number) {
  const sheet = quoteSheet(sheetTitle);
  for (const column of ADDITIVE_COLUMNS) {
    data.push({
      range: `${sheet}!${column}${groupRow}`,
      values: [[`=SUM(${column}${childStart}:${column}${childEnd})`]],
    });
  }
  pushDerived(data, sheetTitle, groupRow);
}

function pushTotal(data: ValueUpdate[], sheetTitle: string, row: number, groupRows: number[]) {
  const sheet = quoteSheet(sheetTitle);
  for (const column of ADDITIVE_COLUMNS) {
    data.push({
      range: `${sheet}!${column}${row}`,
      values: [[`=SUM(${groupRows.map((groupRow) => `${column}${groupRow}`).join(";")})`]],
    });
  }
  pushDerived(data, sheetTitle, row);
}

function addDailyBlockFormulas(data: ValueUpdate[], sheetTitle: string, dataStartRow: number) {
  const detailOffsets = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15];
  const sheet = quoteSheet(sheetTitle);

  for (const offset of detailOffsets) {
    const row = dataStartRow + offset;
    // C is derived because managers only enter G/H/J/L/M/O. B/E come from ad platforms.
    data.push({ range: `${sheet}!C${row}`, values: [[`=MAX(B${row}-H${row};0)`]] });
    pushDerived(data, sheetTitle, row);
  }

  for (const group of GROUPS) {
    pushGroup(
      data,
      sheetTitle,
      dataStartRow + group.rowOffset,
      dataStartRow + group.childStartOffset,
      dataStartRow + group.childEndOffset,
    );
  }

  const totalRow = dataStartRow + TOTAL_OFFSET;
  pushTotal(data, sheetTitle, totalRow, GROUPS.map((group) => dataStartRow + group.rowOffset));
}

function addWeeklyFormulas(data: ValueUpdate[], sheetTitle: string) {
  const sheet = quoteSheet(sheetTitle);
  const weeklyStart = PTS_REPORT_TEMPLATE.weekly.dataStartRow;
  const dailyStarts = PTS_REPORT_TEMPLATE.daily.blocks.map((block) => block.dataStartRow);

  for (let offset = 0; offset <= TOTAL_OFFSET; offset += 1) {
    const row = weeklyStart + offset;
    for (const column of ADDITIVE_COLUMNS) {
      const refs = dailyStarts.map((start) => `${column}${start + offset}`);
      data.push({ range: `${sheet}!${column}${row}`, values: [[`=SUM(${refs.join(";")})`]] });
    }
    pushDerived(data, sheetTitle, row);
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
    .filter((sheet) => !sheet.properties.hidden && isWeeklySheet(sheet.properties.title))
    .map((sheet) => sheet.properties.title);

  const data: ValueUpdate[] = [];
  for (const title of weeklySheets) {
    for (const block of PTS_REPORT_TEMPLATE.daily.blocks) {
      addDailyBlockFormulas(data, title, block.dataStartRow);
    }
    addWeeklyFormulas(data, title);
  }

  await valuesBatchUpdate(spreadsheetId, data);
  return { weeklySheets, formulaCellsUpdated: data.length };
}
