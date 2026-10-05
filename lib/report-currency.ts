import { getGoogleUserAccessToken } from "@/lib/google-oauth";

type SheetMeta = { properties: { sheetId: number; title: string } };

export const REPORTING_CURRENCIES = [
  { code: "USD", label: "USD — долар США" },
  { code: "EUR", label: "EUR — євро" },
  { code: "PLN", label: "PLN — польський злотий" },
  { code: "UAH", label: "UAH — гривня" },
  { code: "GBP", label: "GBP — британський фунт" },
] as const;

export function normalizeReportingCurrency(value: string | null | undefined) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

export function currencySymbol(code: string | null | undefined) {
  switch (normalizeReportingCurrency(code)) {
    case "USD": return "$";
    case "EUR": return "€";
    case "PLN": return "zł";
    case "UAH": return "₴";
    case "GBP": return "£";
    default: return normalizeReportingCurrency(code);
  }
}

export function formatCurrencyAmount(value: number, code: string | null | undefined) {
  const currency = normalizeReportingCurrency(code);
  try {
    return new Intl.NumberFormat("uk-UA", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function currencyPattern(code: string) {
  switch (normalizeReportingCurrency(code)) {
    case "USD": return "$#,##0.00";
    case "EUR": return "€#,##0.00";
    case "PLN": return '#,##0.00 "zł"';
    case "UAH": return '#,##0.00 "₴"';
    case "GBP": return "£#,##0.00";
    default: return `#,##0.00 "${normalizeReportingCurrency(code)}"`;
  }
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

export async function applyReportCurrencyFormats(spreadsheetId: string, currency: string) {
  const normalized = normalizeReportingCurrency(currency);
  const metadata = await googleJson<{ sheets?: SheetMeta[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
  );
  const requests: unknown[] = [];
  const pattern = currencyPattern(normalized);

  for (const sheet of metadata.sheets || []) {
    const { sheetId, title } = sheet.properties;
    const campaignSheet = /^КАМПАНІЇ\s/i.test(title);
    const columns = campaignSheet
      ? [[3, 4], [5, 6]] // D = spend, F = cost/result
      : [[4, 6], [16, 18]]; // E/F = spend/CPL, Q/R = cost KPIs

    for (const [startColumnIndex, endColumnIndex] of columns) {
      requests.push({
        repeatCell: {
          range: { sheetId, startColumnIndex, endColumnIndex },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
  }

  if (requests.length) {
    await googleJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      { method: "POST", body: JSON.stringify({ requests }) },
    );
  }

  return { currency: normalized, sheets: metadata.sheets?.length || 0 };
}
