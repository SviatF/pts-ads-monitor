export type InvoiceSubscription = {
  id: number;
  telegram_chat_id: string;
  meta_account_id: string;
  account_name: string;
  currency?: string | null;
  start_date: string;
  enabled: boolean;
  last_checked_at?: string | null;
};

export type InvoiceSetupSession = {
  telegram_chat_id: string;
  step: "awaiting_account_id" | "awaiting_start_date";
  meta_account_id?: string | null;
  account_name?: string | null;
  currency?: string | null;
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
  if (!response.ok) throw new Error(`Supabase invoice request failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function getInvoiceSetupSession(chatId: string) {
  const rows = await request<InvoiceSetupSession[]>(
    `invoice_setup_sessions?telegram_chat_id=eq.${encodeURIComponent(chatId)}&limit=1`
  );
  return rows[0] || null;
}

export async function setInvoiceSetupSession(row: InvoiceSetupSession) {
  return request("invoice_setup_sessions?on_conflict=telegram_chat_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
}

export async function clearInvoiceSetupSession(chatId: string) {
  return request(`invoice_setup_sessions?telegram_chat_id=eq.${encodeURIComponent(chatId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function upsertInvoiceSubscription(input: Omit<InvoiceSubscription, "id" | "last_checked_at">) {
  return request("invoice_subscriptions?on_conflict=telegram_chat_id,meta_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ ...input, updated_at: new Date().toISOString() }),
  });
}

export async function listInvoiceSubscriptions(chatId?: string) {
  const filter = chatId ? `&telegram_chat_id=eq.${encodeURIComponent(chatId)}` : "";
  return request<InvoiceSubscription[]>(
    `invoice_subscriptions?select=*&enabled=eq.true${filter}&order=created_at.asc`
  );
}

export async function disableInvoiceSubscriptions(chatId: string) {
  return request(`invoice_subscriptions?telegram_chat_id=eq.${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
  });
}

export async function hasDeliveredInvoice(chatId: string, accountId: string, invoiceKey: string) {
  const rows = await request<{ id: number }[]>(
    `invoice_documents?telegram_chat_id=eq.${encodeURIComponent(chatId)}&meta_account_id=eq.${encodeURIComponent(accountId)}&invoice_key=eq.${encodeURIComponent(invoiceKey)}&select=id&limit=1`
  );
  return rows.length > 0;
}

export async function rememberDeliveredInvoice(input: {
  telegram_chat_id: string;
  meta_account_id: string;
  invoice_key: string;
  invoice_date?: string | null;
  amount?: number | null;
  currency?: string | null;
  file_name?: string | null;
  source_url?: string | null;
  telegram_message_id?: string | null;
}) {
  return request("invoice_documents?on_conflict=telegram_chat_id,meta_account_id,invoice_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ ...input, delivered_at: new Date().toISOString() }),
  });
}
