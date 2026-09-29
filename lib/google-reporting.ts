type GoalPreset = {
  key: string;
  label: string;
  columnLabel: string;
  focusLabel: string;
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

function formatUaDate(date: Date) {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function escapeSheetTitle(title: string) {
  return title.replace(/'/g, "''");
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

export async function createProjectReport(input: {
  projectName: string;
  goalKey: string;
  customGoal?: string;
  startDate: string;
}) {
  const cfg = googleConfig();
  const preset = REPORTING_GOALS.find((goal) => goal.key === input.goalKey) || REPORTING_GOALS[0];
  const customGoal = input.customGoal?.trim();
  const goalColumn = preset.key === "other" && customGoal ? customGoal : preset.columnLabel;
  const goalFocus = preset.key === "other" && customGoal ? customGoal.toLowerCase() : preset.focusLabel;
  const fileName = `${input.projectName} × PTS | PERFORMANCE REPORT`;

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

  const metadata = await googleJson<{ sheets: Array<{ properties: { title: string } }> }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(copied.id)}?fields=sheets.properties(title)`,
  );
  const sheetTitle = metadata.sheets?.[0]?.properties?.title;
  if (!sheetTitle) throw new Error("Copied report has no worksheet");
  const sheet = `'${escapeSheetTitle(sheetTitle)}'`;

  const start = parseIsoDate(input.startDate);
  const end = addDays(start, 6);
  const headerRows = [6, 30, 51, 71, 91, 111, 131, 151];
  const dateRows = [29, 50, 70, 90, 110, 130, 150];

  const data: Array<{ range: string; values: string[][] }> = [
    { range: `${sheet}!A1`, values: [[fileName]] },
    { range: `${sheet}!B2`, values: [[formatUaDate(start)]] },
    { range: `${sheet}!D2`, values: [[formatUaDate(end)]] },
    {
      range: `${sheet}!F2`,
      values: [[`Фокус: Цільовий лід → A-лід → проведена зустріч → ${goalFocus}`]],
    },
  ];

  for (const row of headerRows) {
    data.push({ range: `${sheet}!O${row}`, values: [[goalColumn]] });
    data.push({ range: `${sheet}!P${row}`, values: [[`Конверсія\nЗ → ${goalFocus}`]] });
  }

  dateRows.forEach((row, index) => {
    data.push({ range: `${sheet}!A${row}`, values: [[formatUaDate(addDays(start, index))]] });
  });

  await googleJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(copied.id)}/values:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );

  return {
    fileId: copied.id,
    url: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    goalLabel: goalColumn,
    startDate: input.startDate,
    endDate: end.toISOString().slice(0, 10),
  };
}
