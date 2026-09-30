import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";

export type ReportingConfig = {
  meta_account_id: string;
  project_name: string;
  goal_key: string;
  goal_label: string;
  currency: string | null;
  timezone: string;
  report_start_date: string;
  report_end_date: string;
  report_file_id: string;
  report_url: string;
  status: string;
  created_at: string;
  updated_at: string;
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase reporting request failed (${response.status}): ${text}`);
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function deleteReportingConfig(metaAccountId: string) {
  await request<ReportingConfig[]>(
    `reporting_configs?meta_account_id=eq.${encodeURIComponent(metaAccountId)}`,
    { method: "DELETE" },
  );
}

async function reportFileStillExists(fileId: string) {
  if (!fileId) return false;

  try {
    const token = await getGoogleUserAccessToken();
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,trashed`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );

    if (response.status === 404) return false;

    // Do not wipe a valid reporting config because of a temporary Google auth/API issue.
    if (!response.ok) {
      console.warn(`Could not validate Google report ${fileId}: ${response.status} ${await response.text()}`);
      return true;
    }

    const file = (await response.json()) as { id?: string; trashed?: boolean };
    return Boolean(file.id) && !file.trashed;
  } catch (error) {
    console.warn(`Could not validate Google report ${fileId}`, error);
    return true;
  }
}

async function removeStaleConfigIfNeeded(row: ReportingConfig | null) {
  if (!row) return null;
  const exists = await reportFileStillExists(row.report_file_id);
  if (exists) return row;

  await deleteReportingConfig(row.meta_account_id);
  console.info(`Removed stale reporting config for ${row.meta_account_id}: Google Sheet no longer exists`);
  return null;
}

export async function listReportingConfigs(): Promise<ReportingConfig[]> {
  const rows = await request<ReportingConfig[]>("reporting_configs?select=*&order=project_name.asc");
  const checked = await Promise.all(rows.map((row) => removeStaleConfigIfNeeded(row)));
  return checked.filter((row): row is ReportingConfig => Boolean(row));
}

export async function getReportingConfig(metaAccountId: string): Promise<ReportingConfig | null> {
  const rows = await request<ReportingConfig[]>(
    `reporting_configs?meta_account_id=eq.${encodeURIComponent(metaAccountId)}&limit=1`,
  );
  return removeStaleConfigIfNeeded(rows[0] || null);
}

export async function upsertReportingConfig(
  row: Omit<ReportingConfig, "created_at" | "updated_at">,
): Promise<ReportingConfig> {
  const existing = await getReportingConfig(row.meta_account_id);
  const now = new Date().toISOString();
  const rows = await request<ReportingConfig[]>("reporting_configs?on_conflict=meta_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ ...row, updated_at: now }),
  });
  const saved = rows[0];

  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (adminChatId && saved && (!existing || existing.report_file_id !== saved.report_file_id)) {
    try {
      await sendTelegramToChat(
        adminChatId,
        `📊 <b>PTS Reporting</b>\n\n✅ Створено та підключено звіт\nПроєкт: <b>${escapeTelegramHtml(saved.project_name)}</b>\nКабінет: <code>${escapeTelegramHtml(saved.meta_account_id)}</code>\nЦіль: <b>${escapeTelegramHtml(saved.goal_label)}</b>\n\n<a href="${escapeTelegramHtml(saved.report_url)}">Відкрити Google Sheet</a>`,
      );
    } catch (error) {
      console.error("Could not notify main Telegram chat about report creation", error);
    }
  }

  return saved;
}
