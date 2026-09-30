export type PerformanceAlert = {
  id: number;
  meta_account_id: string;
  alert_key: string;
  alert_type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  escalated_at: string | null;
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}) {
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
  if (!response.ok) throw new Error(`Supabase performance alert request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function isActionable(alert: PerformanceAlert) {
  return alert.severity === "action_required" || alert.severity === "critical";
}

export async function acknowledgePerformanceAlert(id: number, by: string) {
  const existing = await request<PerformanceAlert[]>(`performance_alerts?id=eq.${id}&limit=1`);
  const alert = existing[0];
  if (!alert || !isActionable(alert)) return null;

  const rows = await request<PerformanceAlert[]>(`performance_alerts?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ acknowledged_at: new Date().toISOString(), acknowledged_by: by, updated_at: new Date().toISOString() }),
  });
  return rows[0] || null;
}

export async function resolvePerformanceAlert(id: number, by: string) {
  const now = new Date().toISOString();
  const rows = await request<PerformanceAlert[]>(`performance_alerts?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ acknowledged_at: now, acknowledged_by: by, resolved_at: now, updated_at: now }),
  });
  return rows[0] || null;
}
