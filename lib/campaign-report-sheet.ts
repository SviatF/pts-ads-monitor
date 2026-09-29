import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { periodForDate } from "@/lib/report-periods";

export type CampaignPerformanceRow = {
  date: string;
  campaignId: string;
  campaignName: string;
  channel: string;
  spend: number;
  results: number;
};

type SheetMeta = { properties: { sheetId: number; title: string } };

type SectionRow = {
  period: string;
  campaignName: string;
  channel: string;
  spend: number;
  results: number;
};

function monthKey(dateIso: string) {
  const [year, month] = dateIso.split("-");
  return `${month}.${year}`;
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatUaDate(value: string) {
  const date = parseIsoDate(value);
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function sheetTitle(month: string) {
  return `КАМПАНІЇ ${month}`;
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

async function getSheets(spreadsheetId: string) {
  const body = await googleJson<{ sheets?: SheetMeta[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
  );
  return body.sheets || [];
}

async function ensureSheet(spreadsheetId: string, title: string) {
  const sheets = await getSheets(spreadsheetId);
  const existing = sheets.find((sheet) => sheet.properties.title === title);
  if (existing) return existing.properties.sheetId;

  const created = await googleJson<{
    replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
  }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 3000, columnCount: 6 } } } }],
    }),
  });
  const sheetId = created.replies?.[0]?.addSheet?.properties?.sheetId;
  if (typeof sheetId !== "number") throw new Error(`Could not create campaign sheet ${title}`);
  return sheetId;
}

async function clearSheet(spreadsheetId: string, title: string) {
  const token = await getGoogleUserAccessToken();
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${title.replace(/'/g, "''")}'!A:Z`)}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" },
  );
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
}

function aggregate(rows: CampaignPerformanceRow[], period: (row: CampaignPerformanceRow) => string): SectionRow[] {
  const map = new Map<string, SectionRow>();
  for (const row of rows) {
    const label = period(row);
    const key = `${label}|${row.campaignId || row.campaignName}`;
    const current = map.get(key) || {
      period: label,
      campaignName: row.campaignName,
      channel: row.channel,
      spend: 0,
      results: 0,
    };
    current.spend += row.spend;
    current.results += row.results;
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => {
    const periodCompare = a.period.localeCompare(b.period);
    if (periodCompare) return periodCompare;
    return b.spend - a.spend;
  });
}

function tableRows(rows: SectionRow[]) {
  return rows.map((row) => [
    row.period,
    row.campaignName,
    row.channel,
    Number(row.spend.toFixed(2)),
    row.results,
    row.results > 0 ? Number((row.spend / row.results).toFixed(2)) : 0,
  ]);
}

function buildValues(month: string, rows: CampaignPerformanceRow[]) {
  const monthAgg = aggregate(rows, () => month);
  const weekAgg = aggregate(rows, (row) => periodForDate(parseIsoDate(row.date)).title);
  const dayAgg = aggregate(rows, (row) => formatUaDate(row.date));

  const values: Array<Array<string | number>> = [];
  values.push([`META CAMPAIGNS PERFORMANCE · ${month}`]);
  values.push(["Автоматичний технічний зріз усіх кампаній. Менеджери цей аркуш не заповнюють."]);
  values.push([]);

  values.push(["МІСЯЦЬ"]);
  values.push(["Період", "Кампанія", "Канал / посадка", "Витрати", "Результат", "Ціна за результат"]);
  values.push(...tableRows(monthAgg));
  values.push([]);
  values.push(["ПО ТИЖНЯХ"]);
  values.push(["Період", "Кампанія", "Канал / посадка", "Витрати", "Результат", "Ціна за результат"]);
  values.push(...tableRows(weekAgg));
  values.push([]);
  values.push(["ПО ДНЯХ"]);
  values.push(["Дата", "Кампанія", "Канал / посадка", "Витрати", "Результат", "Ціна за результат"]);
  values.push(...tableRows(dayAgg));

  return { values, monthRows: monthAgg.length, weekRows: weekAgg.length, dayRows: dayAgg.length };
}

async function writeValues(spreadsheetId: string, title: string, values: Array<Array<string | number>>) {
  const token = await getGoogleUserAccessToken();
  const range = `'${title.replace(/'/g, "''")}'!A1:F${Math.max(values.length, 1)}`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    },
  );
  if (!response.ok) throw new Error(`Google API failed (${response.status}): ${await response.text()}`);
}

async function formatSheet(spreadsheetId: string, sheetId: number, values: Array<Array<string | number>>) {
  const headerRows: number[] = [];
  const sectionRows: number[] = [];
  values.forEach((row, index) => {
    const first = String(row[0] ?? "");
    if (first === "Період" || first === "Дата") headerRows.push(index);
    if (first === "МІСЯЦЬ" || first === "ПО ТИЖНЯХ" || first === "ПО ДНЯХ") sectionRows.push(index);
  });

  const requests: unknown[] = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 5 } }, fields: "gridProperties.frozenRowCount" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 125 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 420 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 6 }, properties: { pixelSize: 135 }, fields: "pixelSize" } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: 6 }, cell: { userEnteredFormat: { textFormat: { fontFamily: "Arial", fontSize: 9 }, verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(textFormat,verticalAlignment)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.04, green: 0.18, blue: 0.22 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 14 }, horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat" } },
    { repeatCell: { range: { sheetId, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
    { repeatCell: { range: { sheetId, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
  ];

  for (const rowIndex of sectionRows) {
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 6 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.18, green: 0.18, blue: 0.18 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true } } }, fields: "userEnteredFormat" } });
  }
  for (const rowIndex of headerRows) {
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 6 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.04, green: 0.18, blue: 0.22 }, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }, wrapStrategy: "WRAP" } }, fields: "userEnteredFormat" } });
  }

  await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

export async function syncCampaignPerformanceSheets(spreadsheetId: string, rows: CampaignPerformanceRow[]) {
  const activeRows = rows.filter((row) => row.spend > 0 || row.results > 0);
  const byMonth = new Map<string, CampaignPerformanceRow[]>();
  for (const row of activeRows) {
    const month = monthKey(row.date);
    const list = byMonth.get(month) || [];
    list.push(row);
    byMonth.set(month, list);
  }

  const sheets: Array<{ title: string; rows: number }> = [];
  for (const [month, monthRows] of byMonth) {
    const title = sheetTitle(month);
    const sheetId = await ensureSheet(spreadsheetId, title);
    await clearSheet(spreadsheetId, title);
    const built = buildValues(month, monthRows);
    await writeValues(spreadsheetId, title, built.values);
    await formatSheet(spreadsheetId, sheetId, built.values);
    sheets.push({ title, rows: monthRows.length });
  }

  return { sheets, sourceRows: activeRows.length };
}
