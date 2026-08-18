export type StoredAccount = {
  meta_account_id: string;
  name: string;
  account_status: number;
  status_label: string;
  status_kind: string;
  last_checked_at: string;
  status_changed_at: string;
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
    throw new Error(`Supabase request failed (${response.status}): ${text}`);
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function getStoredAccount(metaAccountId: string): Promise<StoredAccount | null> {
  const rows = await request<StoredAccount[]>(`ad_accounts?meta_account_id=eq.${encodeURIComponent(metaAccountId)}&limit=1`);
  return rows[0] || null;
}

export async function listStoredAccounts(): Promise<StoredAccount[]> {
  return request<StoredAccount[]>("ad_accounts?select=*&order=name.asc");
}

export async function upsertAccount(row: StoredAccount) {
  return request<StoredAccount[]>("ad_accounts?on_conflict=meta_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
}

export async function hasSeenRejectedAd(adId: string): Promise<boolean> {
  const rows = await request<{ ad_id: string }[]>(`rejected_ads?ad_id=eq.${encodeURIComponent(adId)}&select=ad_id&limit=1`);
  return rows.length > 0;
}

export async function rememberRejectedAd(input: {
  ad_id: string;
  ad_name: string;
  meta_account_id: string;
  account_name: string;
  first_seen_at: string;
}) {
  return request("rejected_ads?on_conflict=ad_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(input),
  });
}

export async function countRejectedAds(): Promise<number> {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/rejected_ads?select=ad_id`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
    cache: "no-store",
  });
  const range = response.headers.get("content-range") || "0/0";
  return Number(range.split("/")[1] || 0);
}
