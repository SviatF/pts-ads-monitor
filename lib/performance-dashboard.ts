import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";

export type DashboardAlert = {
  id: number;
  meta_account_id: string;
  alert_type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
};

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string): Promise<T> {
  const { url, key } = cfg();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Performance dashboard request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const SUPPRESSED = new Set(["CAMPAIGN_WASTE", "A_LEAD_DROP"]);

export function healthForAlerts(alerts: DashboardAlert[]) {
  const open = alerts.filter((a) => !a.resolved_at && !SUPPRESSED.has(a.alert_type));
  if (open.some((a) => a.severity === "critical")) return "critical" as const;
  if (open.some((a) => a.severity === "action_required")) return "action" as const;
  if (open.some((a) => a.severity === "warning")) return "watch" as const;
  return "healthy" as const;
}

export async function getPerformanceDashboardData() {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const [alertsRaw, configs] = await Promise.all([
    request<DashboardAlert[]>(`performance_alerts?select=*&or=(resolved_at.is.null,first_seen_at.gte.${encodeURIComponent(since)})&order=last_seen_at.desc&limit=1000`),
    listPerformanceMonitoringConfigs(),
  ]);
  const alerts = alertsRaw.filter((a) => !SUPPRESSED.has(a.alert_type));
  const projectNames = new Map(configs.map((c) => [c.meta_account_id, c.project_name]));
  const owners = new Map(configs.map((c) => [c.meta_account_id, c.targetologist_telegram || ""]));
  return { alerts, configs, projectNames, owners };
}
