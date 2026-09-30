import { listReportingConfigs } from "@/lib/reporting-store";
import { listReportingTelegramSubscriptionsForAccount } from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaAction = { action_type?: string; value?: string };
type AdInsight = {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  actions?: MetaAction[];
};
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };

type AlertRecord = {
  id: number;
  meta_account_id: string;
  alert_key: string;
  alert_type: string;
  severity: string;
  last_notified_at: string | null;
  resolved_at: string | null;
};

const RESULT_ACTION_PRIORITY = [
  "onsite_conversion.messaging_conversation_started_7d",
  "messaging_conversation_started_7d",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "onsite_conversion.contact_website",
  "offsite_conversion.fb_pixel_contact",
  "contact",
];

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function supabaseRequest<T>(path: string, init: RequestInit = {}) {
  const { url, key } = supabaseConfig();
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
  if (!response.ok) throw new Error(`Supabase performance request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function metaToken() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN is not configured");
  return token;
}

async function metaGraphAll<T>(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", metaToken());
  const rows: T[] = [];
  let next: string | null = url.toString();
  while (next) {
    const response = await fetch(next, { cache: "no-store" });
    const body = (await response.json()) as MetaPage<T>;
    if (!response.ok || body.error) throw new Error(body.error?.message || `Meta API request failed (${response.status})`);
    rows.push(...(body.data || []));
    next = body.paging?.next || null;
  }
  return rows;
}

function results(actions?: MetaAction[]) {
  const map = new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)]));
  for (const type of RESULT_ACTION_PRIORITY) if (map.has(type)) return Number(map.get(type) || 0);
  return 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dateIso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return dateIso(d); }

function mention(value: string | null) {
  if (!value) return "";
  const username = value.trim().replace(/^@/, "");
  return username ? `@${escapeTelegramHtml(username)}` : "";
}

async function shouldNotify(metaAccountId: string, alertKey: string) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?meta_account_id=eq.${encodeURIComponent(metaAccountId)}&alert_key=eq.${encodeURIComponent(alertKey)}&limit=1`);
  const current = rows[0];
  if (!current || !current.last_notified_at) return true;
  return Date.now() - new Date(current.last_notified_at).getTime() >= 12 * 60 * 60 * 1000;
}

async function saveAlert(input: { metaAccountId: string; alertKey: string; alertType: string; severity: string; title: string; details: Record<string, unknown>; notified: boolean }) {
  const now = new Date().toISOString();
  await supabaseRequest("performance_alerts?on_conflict=meta_account_id,alert_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      meta_account_id: input.metaAccountId,
      alert_key: input.alertKey,
      alert_type: input.alertType,
      severity: input.severity,
      title: input.title,
      details: input.details,
      last_seen_at: now,
      updated_at: now,
      resolved_at: null,
      ...(input.notified ? { last_notified_at: now } : {}),
    }),
  });
}

export async function runPerformanceMonitor() {
  const configs = (await listReportingConfigs()).filter((item) => item.performance_monitoring_enabled);
  const summary = { projects: configs.length, alerts: 0, notifications: 0, errors: [] as string[] };

  for (const config of configs) {
    try {
      const objectId = config.meta_account_id.startsWith("act_") ? config.meta_account_id : `act_${config.meta_account_id}`;
      const insights = await metaGraphAll<AdInsight>(`${objectId}/insights`, {
        level: "ad",
        fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,actions",
        time_range: JSON.stringify({ since: daysAgo(2), until: daysAgo(0) }),
        limit: "500",
      });

      const byAdset = new Map<string, Array<{ adId: string; adName: string; adsetName: string; spend: number; results: number }>>();
      for (const row of insights) {
        const key = row.adset_id || row.adset_name || "unknown";
        const bucket = byAdset.get(key) || [];
        bucket.push({
          adId: row.ad_id || row.ad_name || "unknown",
          adName: row.ad_name || "(unnamed ad)",
          adsetName: row.adset_name || "(unnamed ad set)",
          spend: Number(row.spend || 0),
          results: results(row.actions),
        });
        byAdset.set(key, bucket);
      }

      for (const [adsetId, creatives] of byAdset) {
        const productive = creatives.filter((item) => item.results > 0);
        if (productive.length < 2) continue;
        const peerCpls = productive.map((item) => item.spend / item.results).filter((value) => Number.isFinite(value) && value > 0);
        const peerMedianCpl = median(peerCpls);
        if (!peerMedianCpl) continue;

        for (const creative of creatives) {
          const threshold = Math.max(Number(config.creative_waste_min_spend || 15), peerMedianCpl * Number(config.creative_waste_cpl_multiplier || 1.5));
          if (creative.results !== 0 || creative.spend < threshold) continue;

          const alertKey = `creative_waste:${adsetId}:${creative.adId}`;
          const notify = await shouldNotify(config.meta_account_id, alertKey);
          summary.alerts += 1;
          await saveAlert({
            metaAccountId: config.meta_account_id,
            alertKey,
            alertType: "CREATIVE_WASTE",
            severity: creative.spend >= threshold * 1.5 ? "critical" : "action_required",
            title: "Оптимізація потрібна — креативи",
            details: { adsetId, adsetName: creative.adsetName, adId: creative.adId, adName: creative.adName, spend: creative.spend, results: creative.results, peerMedianCpl, threshold },
            notified: notify,
          });
          if (!notify) continue;

          const subscriptions = await listReportingTelegramSubscriptionsForAccount(config.meta_account_id);
          const peers = productive
            .sort((a, b) => (a.spend / a.results) - (b.spend / b.results))
            .slice(0, 4)
            .map((item) => `• ${escapeTelegramHtml(item.adName)} — $${item.spend.toFixed(2)} / ${item.results} result / CPL $${(item.spend / item.results).toFixed(2)}`)
            .join("\n");
          const tag = mention(config.targetologist_telegram);
          const message = `⚡ <b>ОПТИМІЗАЦІЯ ПОТРІБНА — КРЕАТИВИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nAd set: <b>${escapeTelegramHtml(creative.adsetName)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\n\n🔴 <b>${escapeTelegramHtml(creative.adName)}</b>\nSpend: <b>$${creative.spend.toFixed(2)}</b>\nResults: <b>0</b>\n\nІнші креативи в цьому ad set:\n${peers}\n\nПерегляньте оптимізацію в цьому ad set.`;
          for (const subscription of subscriptions) {
            await sendTelegramToChat(subscription.telegram_chat_id, message);
            summary.notifications += 1;
          }
        }
      }
    } catch (error) {
      summary.errors.push(`${config.project_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summary;
}
