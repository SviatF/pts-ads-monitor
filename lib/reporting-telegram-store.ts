export type ReportingTelegramSubscription = {
  id: number;
  telegram_chat_id: string;
  meta_account_id: string;
  account_name: string;
  enabled: boolean;
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
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase reporting Telegram request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function listReportingTelegramSubscriptions(chatId?: string) {
  const filter = chatId ? `&telegram_chat_id=eq.${encodeURIComponent(chatId)}` : "";
  return request<ReportingTelegramSubscription[]>(
    `reporting_telegram_subscriptions?select=*&enabled=eq.true${filter}&order=account_name.asc`,
  );
}

export async function listReportingTelegramSubscriptionsForAccount(metaAccountId: string) {
  return request<ReportingTelegramSubscription[]>(
    `reporting_telegram_subscriptions?select=*&enabled=eq.true&meta_account_id=eq.${encodeURIComponent(metaAccountId)}`,
  );
}

export async function upsertReportingTelegramSubscription(input: {
  telegram_chat_id: string;
  meta_account_id: string;
  account_name: string;
}) {
  const rows = await request<ReportingTelegramSubscription[]>(
    "reporting_telegram_subscriptions?on_conflict=telegram_chat_id,meta_account_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ ...input, enabled: true, updated_at: new Date().toISOString() }),
    },
  );
  return rows[0];
}

export async function disableReportingTelegramSubscription(chatId: string, metaAccountId?: string) {
  const accountFilter = metaAccountId ? `&meta_account_id=eq.${encodeURIComponent(metaAccountId)}` : "";
  return request<ReportingTelegramSubscription[]>(
    `reporting_telegram_subscriptions?telegram_chat_id=eq.${encodeURIComponent(chatId)}${accountFilter}`,
    {
      method: "PATCH",
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    },
  );
}
