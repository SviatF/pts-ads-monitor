export type PerformanceMonitoringConfig = {
  meta_account_id: string;
  project_name: string;
  targetologist_telegram: string | null;
  enabled: boolean;
  source: "monitor_only" | "reporting" | string;
  creative_waste_min_spend: number;
  creative_waste_cpl_multiplier: number;
  cpl_warning_pct: number;
  cpl_critical_pct: number;
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
  if (!response.ok) throw new Error(`Supabase performance config request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function listPerformanceMonitoringConfigs() {
  return request<PerformanceMonitoringConfig[]>("performance_monitoring_configs?select=*&order=project_name.asc");
}

export async function getPerformanceMonitoringConfig(metaAccountId: string) {
  const rows = await request<PerformanceMonitoringConfig[]>(`performance_monitoring_configs?select=*&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&limit=1`);
  return rows[0] || null;
}

export async function upsertPerformanceMonitoringConfig(input: {
  meta_account_id: string;
  project_name: string;
  targetologist_telegram?: string | null;
  enabled?: boolean;
  source?: string;
  creative_waste_min_spend?: number;
  creative_waste_cpl_multiplier?: number;
  cpl_warning_pct?: number;
  cpl_critical_pct?: number;
}) {
  const existing = await getPerformanceMonitoringConfig(input.meta_account_id);
  const rows = await request<PerformanceMonitoringConfig[]>("performance_monitoring_configs?on_conflict=meta_account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      meta_account_id: input.meta_account_id,
      project_name: input.project_name,
      targetologist_telegram: input.targetologist_telegram ?? existing?.targetologist_telegram ?? null,
      enabled: input.enabled ?? existing?.enabled ?? true,
      source: input.source ?? existing?.source ?? "monitor_only",
      creative_waste_min_spend: input.creative_waste_min_spend ?? existing?.creative_waste_min_spend ?? 15,
      creative_waste_cpl_multiplier: input.creative_waste_cpl_multiplier ?? existing?.creative_waste_cpl_multiplier ?? 1.5,
      cpl_warning_pct: input.cpl_warning_pct ?? existing?.cpl_warning_pct ?? 25,
      cpl_critical_pct: input.cpl_critical_pct ?? existing?.cpl_critical_pct ?? 40,
      updated_at: new Date().toISOString(),
    }),
  });
  return rows[0];
}

export async function setPerformanceMonitoringEnabled(metaAccountId: string, enabled: boolean) {
  const rows = await request<PerformanceMonitoringConfig[]>(`performance_monitoring_configs?meta_account_id=eq.${encodeURIComponent(metaAccountId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled, updated_at: new Date().toISOString() }),
  });
  return rows[0] || null;
}
