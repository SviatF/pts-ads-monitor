import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";
import { sendPerformanceMessage } from "@/lib/performance-telegram";

type AlertRow = {
  id: number;
  meta_account_id: string;
  alert_type: string;
  severity: string;
  title: string;
  details?: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string): Promise<T> {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase performance brief failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function requiresAck(item: AlertRow) {
  return item.severity === "action_required" || item.severity === "critical";
}

const DISABLED_ALERT_TYPES = new Set(["CAMPAIGN_WASTE", "A_LEAD_DROP", "NO_OPTIMIZATION"]);
const DIGEST_TYPES = new Set(["PERFORMANCE_WATCH_V4", "CREATIVE_PIPELINE_V4", "RECOVERED_V4"]);

export async function sendPerformanceBrief(kind: "morning" | "evening") {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>(`performance_alerts?select=id,meta_account_id,alert_type,severity,title,details,first_seen_at,last_seen_at,last_notified_at,acknowledged_at,resolved_at&or=(last_seen_at.gte.${encodeURIComponent(since)},resolved_at.gte.${encodeURIComponent(since)})&order=last_seen_at.desc&limit=250`),
    listPerformanceMonitoringConfigs(),
  ]);
  const alerts = alertsRaw.filter((item) => !DISABLED_ALERT_TYPES.has(item.alert_type));
  const activeConfigs = configs.filter((item) => item.enabled);
  const names = new Map(activeConfigs.map((item) => [item.meta_account_id, item.project_name]));
  const open = alerts.filter((item) => !item.resolved_at && ["warning", "action_required", "critical"].includes(item.severity));
  const digest = alerts.filter((item) =>
    !item.resolved_at &&
    item.alert_type !== "CREATIVE_WINNER_V4" &&
    (DIGEST_TYPES.has(item.alert_type) || item.details?.digest_only === true)
  );
  const critical = open.filter((item) => item.severity === "critical");
  const action = open.filter((item) => item.severity === "action_required");
  const warning = open.filter((item) => item.severity === "warning");
  const unack = open.filter((item) => requiresAck(item) && !item.acknowledged_at);
  const resolved = alerts.filter((item) => item.resolved_at && new Date(item.resolved_at).getTime() >= Date.now() - 24 * 60 * 60 * 1000);

  const rows = open.slice(0, 8).map((item) => {
    const icon = item.severity === "critical" ? "🔴" : item.severity === "action_required" ? "🟠" : "🟡";
    const state = requiresAck(item)
      ? (item.acknowledged_at ? " · ✅ в роботі" : " · ⏳ потрібна реакція")
      : " · 👀 на контролі";
    return `${icon} <b>${escapeTelegramHtml(names.get(item.meta_account_id) || item.meta_account_id)}</b> — ${escapeTelegramHtml(item.title)}${state}`;
  });

  const digestRows = digest.slice(0, 8).map((item) => {
    const icon = item.alert_type === "CREATIVE_PIPELINE_V4" ? "🧠" : item.title.toLowerCase().includes("віднов") ? "🟢" : "👀";
    return `${icon} <b>${escapeTelegramHtml(names.get(item.meta_account_id) || item.meta_account_id)}</b> — ${escapeTelegramHtml(item.title)}`;
  });

  if (kind === "morning") {
    const message = `☀️ <b>PTS PERFORMANCE · MORNING BRIEF</b>\n\nКабінетів під контролем: <b>${activeConfigs.length}</b>\n🔴 Critical: <b>${critical.length}</b>\n🟠 Action required: <b>${action.length}</b>\n🟡 Warning: <b>${warning.length}</b>\n⏳ Без реакції по actionable alerts: <b>${unack.length}</b>${rows.length ? `\n\n<b>Що потребує уваги:</b>\n${rows.join("\n")}` : "\n\n🟢 Активних проблем, що потребують уваги, немає."}${digestRows.length ? `\n\n<b>Digest / інформаційні сигнали:</b>\n${digestRows.join("\n")}` : ""}\n\nФокус дня: critical → action required. Watch / pipeline — інформаційно; winner приходить окремим коротким сигналом.`;
    await sendPerformanceMessage(message);
    return { kind, projects: activeConfigs.length, open: open.length, unacknowledged: unack.length, digest: digest.length };
  }

  const message = `🌙 <b>PTS PERFORMANCE · END OF DAY</b>\n\nAlerts за 24 год: <b>${alerts.length}</b>\nЗакрито / recovered: <b>${resolved.length}</b>\nЩе відкрито: <b>${open.length}</b>\nБез реакції по actionable alerts: <b>${unack.length}</b>${rows.length ? `\n\n<b>Що лишається на контролі:</b>\n${rows.join("\n")}` : "\n\n✅ На кінець дня відкритих performance-проблем немає."}${digestRows.length ? `\n\n<b>Digest / watch:</b>\n${digestRows.join("\n")}` : ""}`;
  await sendPerformanceMessage(message);
  return { kind, projects: activeConfigs.length, open: open.length, unacknowledged: unack.length, resolved: resolved.length, digest: digest.length };
}
