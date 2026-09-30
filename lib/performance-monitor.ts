import { listReportingConfigs } from "@/lib/reporting-store";
import { listReportingTelegramSubscriptionsForAccount } from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaAction = { action_type?: string; value?: string };
type AdInsight = { ad_id?: string; ad_name?: string; adset_id?: string; adset_name?: string; campaign_id?: string; campaign_name?: string; spend?: string; actions?: MetaAction[] };
type AccountInsight = { spend?: string; actions?: MetaAction[] };
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };
type AlertRecord = {
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

type ManagerQuality = { totalLeads: number; targetLeads: number; spam: number; aLeads: number };

const RESULT_ACTION_PRIORITY = [
  "onsite_conversion.messaging_conversation_started_7d", "messaging_conversation_started_7d",
  "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "lead",
  "onsite_conversion.contact_website", "offsite_conversion.fb_pixel_contact", "contact",
];

function supabaseConfig() {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function supabaseRequest<T>(path: string, init: RequestInit = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase performance request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function metaToken() { const token = process.env.META_ACCESS_TOKEN; if (!token) throw new Error("META_ACCESS_TOKEN is not configured"); return token; }

async function metaGraphAll<T>(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", metaToken());
  const rows: T[] = []; let next: string | null = url.toString();
  while (next) {
    const response = await fetch(next, { cache: "no-store" });
    const body = (await response.json()) as MetaPage<T>;
    if (!response.ok || body.error) throw new Error(body.error?.message || `Meta API request failed (${response.status})`);
    rows.push(...(body.data || [])); next = body.paging?.next || null;
  }
  return rows;
}

function results(actions?: MetaAction[]) {
  const map = new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)]));
  for (const type of RESULT_ACTION_PRIORITY) if (map.has(type)) return Number(map.get(type) || 0);
  return 0;
}
function median(values: number[]) { if (!values.length) return 0; const sorted=[...values].sort((a,b)=>a-b); const m=Math.floor(sorted.length/2); return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2; }
function dateIso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d=new Date(); d.setUTCDate(d.getUTCDate()-days); return dateIso(d); }
function mention(value: string | null) { if (!value) return ""; const username=value.trim().replace(/^@/,""); return username ? `@${escapeTelegramHtml(username)}` : ""; }
function quoteSheet(title: string) { return `'${title.replace(/'/g, "''")}'`; }
function pct(value: number) { return `${Math.round(value * 100)}%`; }

async function getAlert(metaAccountId: string, alertKey: string) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?meta_account_id=eq.${encodeURIComponent(metaAccountId)}&alert_key=eq.${encodeURIComponent(alertKey)}&limit=1`);
  return rows[0] || null;
}

async function shouldNotify(metaAccountId: string, alertKey: string) {
  const current = await getAlert(metaAccountId, alertKey);
  if (!current || !current.last_notified_at) return true;
  return Date.now() - new Date(current.last_notified_at).getTime() >= 12 * 60 * 60 * 1000;
}

async function saveAlert(input: { metaAccountId: string; alertKey: string; alertType: string; severity: string; title: string; details: Record<string, unknown>; notified: boolean }) {
  const now = new Date().toISOString();
  const rows = await supabaseRequest<AlertRecord[]>("performance_alerts?on_conflict=meta_account_id,alert_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      meta_account_id: input.metaAccountId, alert_key: input.alertKey, alert_type: input.alertType,
      severity: input.severity, title: input.title, details: input.details, last_seen_at: now, updated_at: now,
      resolved_at: null, ...(input.notified ? { last_notified_at: now, acknowledged_at: null, acknowledged_by: null, escalated_at: null } : {}),
    }),
  });
  return rows[0];
}

async function broadcast(metaAccountId: string, message: string) {
  const subscriptions = await listReportingTelegramSubscriptionsForAccount(metaAccountId);
  for (const subscription of subscriptions) await sendTelegramToChat(subscription.telegram_chat_id, message);
  return subscriptions.length;
}

async function accountWindow(objectId: string, since: string, until: string) {
  const rows = await metaGraphAll<AccountInsight>(`${objectId}/insights`, { level: "account", fields: "spend,actions", time_range: JSON.stringify({ since, until }), limit: "20" });
  return {
    spend: rows.reduce((sum, row) => sum + Number(row.spend || 0), 0),
    results: rows.reduce((sum, row) => sum + results(row.actions), 0),
  };
}

function managerDates(fromDaysAgo: number, toDaysAgo: number) {
  const dates: Date[] = [];
  for (let d = fromDaysAgo; d >= toDaysAgo; d -= 1) {
    const date = new Date(); date.setUTCHours(0,0,0,0); date.setUTCDate(date.getUTCDate() - d); dates.push(date);
  }
  return dates;
}

async function readManagerQuality(spreadsheetId: string, dates: Date[], reportingStartDate: string): Promise<ManagerQuality> {
  const eligible = dates.filter((date) => dateIso(date) >= reportingStartDate);
  if (!eligible.length) return { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0 };
  const ranges = eligible.map((date) => {
    const period = periodForDate(date);
    const blocks = dailyBlocksForDays(periodLength(period));
    const block = blocks[dayIndexInPeriod(date, period)];
    const totalRow = block.dataStartRow + 16;
    return `${quoteSheet(period.title)}!B${totalRow}:J${totalRow}`;
  });
  const token = await getGoogleUserAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  ranges.forEach((range) => url.searchParams.append("ranges", range));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) return { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0 };
  const body = await response.json() as { valueRanges?: Array<{ values?: Array<Array<string | number>> }> };
  const total = { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0 };
  for (const valueRange of body.valueRanges || []) {
    const row = valueRange.values?.[0] || [];
    total.totalLeads += Number(row[0] || 0); // B
    total.targetLeads += Number(row[5] || 0); // G
    total.spam += Number(row[6] || 0); // H
    total.aLeads += Number(row[8] || 0); // J
  }
  return total;
}

async function escalateUnacknowledged() {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const stillFresh = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const alerts = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&resolved_at=is.null&acknowledged_at=is.null&escalated_at=is.null&last_notified_at=lte.${encodeURIComponent(cutoff)}&last_seen_at=gte.${encodeURIComponent(stillFresh)}&order=last_notified_at.asc&limit=50`);
  let notifications = 0;
  for (const alert of alerts) {
    const configs = await listReportingConfigs();
    const config = configs.find((item) => item.meta_account_id === alert.meta_account_id);
    if (!config) continue;
    const tag = mention(config.targetologist_telegram);
    const currentSpend = Number(alert.details?.spend || alert.details?.currentSpend || 0);
    const notifiedSpend = Number(alert.details?.notifiedSpend || 0);
    const extraSpend = currentSpend > notifiedSpend && notifiedSpend > 0 ? currentSpend - notifiedSpend : 0;
    const message = `🚨 <b>ALERT НЕ ОПРАЦЬОВАНИЙ 2+ ГОДИНИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nПроблема: <b>${escapeTelegramHtml(alert.title)}</b>\nAlert ID: <code>${alert.id}</code>${extraSpend > 0 ? `\nПісля першого попередження витрачено ще: <b>$${extraSpend.toFixed(2)}</b>` : ""}\n\nПідтвердьте: <code>/perf_ack ${alert.id}</code> або закрийте: <code>/perf_done ${alert.id}</code>`;
    notifications += await broadcast(alert.meta_account_id, message);
    await supabaseRequest(`performance_alerts?id=eq.${alert.id}`, { method: "PATCH", body: JSON.stringify({ escalated_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  }
  return notifications;
}

export async function runPerformanceMonitor() {
  const configs = (await listReportingConfigs()).filter((item) => item.performance_monitoring_enabled);
  const summary = { projects: configs.length, alerts: 0, notifications: 0, errors: [] as string[] };

  for (const config of configs) {
    try {
      const objectId = config.meta_account_id.startsWith("act_") ? config.meta_account_id : `act_${config.meta_account_id}`;
      const tag = mention(config.targetologist_telegram);

      // Account-level comparison uses only completed days to avoid false alarms from a partial current day.
      const current = await accountWindow(objectId, daysAgo(3), daysAgo(1));
      const baseline = await accountWindow(objectId, daysAgo(10), daysAgo(4));
      const currentCpl = current.results > 0 ? current.spend / current.results : 0;
      const baselineCpl = baseline.results > 0 ? baseline.spend / baseline.results : 0;

      if (baselineCpl > 0 && current.results >= 3 && current.spend >= baselineCpl * 3) {
        const growth = ((currentCpl / baselineCpl) - 1) * 100;
        if (growth >= Number(config.cpl_warning_pct || 25)) {
          const critical = growth >= Number(config.cpl_critical_pct || 40);
          const key = `cpl_spike:${critical ? "critical" : "warning"}`;
          const notify = await shouldNotify(config.meta_account_id, key);
          summary.alerts += 1;
          const alert = await saveAlert({ metaAccountId: config.meta_account_id, alertKey: key, alertType: "CPL_SPIKE", severity: critical ? "critical" : "warning", title: "CPL виріс", details: { currentCpl, baselineCpl, growth, currentSpend: current.spend, currentResults: current.results, notifiedSpend: notify ? current.spend : (await getAlert(config.meta_account_id, key))?.details?.notifiedSpend || current.spend }, notified: notify });
          if (notify) summary.notifications += await broadcast(config.meta_account_id, `${critical ? "🔴" : "🟠"} <b>CPL ${critical ? "CRITICAL" : "WARNING"}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nCPL зараз: <b>$${currentCpl.toFixed(2)}</b>\nBaseline CPL: <b>$${baselineCpl.toFixed(2)}</b>\nЗміна: <b>+${growth.toFixed(0)}%</b>\nSpend: <b>$${current.spend.toFixed(2)}</b> · Results: <b>${current.results}</b>\nAlert ID: <code>${alert.id}</code>\n\nПеревірте оптимізацію кабінету. Підтвердити: <code>/perf_ack ${alert.id}</code>`);
        }
      }

      if (baselineCpl > 0 && current.results === 0 && current.spend >= baselineCpl * 2) {
        const key = "spend_without_results:account";
        const old = await getAlert(config.meta_account_id, key);
        const notify = await shouldNotify(config.meta_account_id, key);
        summary.alerts += 1;
        const alert = await saveAlert({ metaAccountId: config.meta_account_id, alertKey: key, alertType: "SPEND_WITHOUT_RESULTS", severity: "critical", title: "Spend без результатів", details: { currentSpend: current.spend, baselineCpl, notifiedSpend: notify ? current.spend : old?.details?.notifiedSpend || current.spend }, notified: notify });
        if (notify) summary.notifications += await broadcast(config.meta_account_id, `🚨 <b>SPEND БЕЗ РЕЗУЛЬТАТІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nSpend: <b>$${current.spend.toFixed(2)}</b>\nResults: <b>0</b>\nПопередній CPL: <b>$${baselineCpl.toFixed(2)}</b>\nAlert ID: <code>${alert.id}</code>\n\nПотрібна перевірка кабінету. Підтвердити: <code>/perf_ack ${alert.id}</code>`);
      }

      // Lead volume: compare average completed-day results, but only alert when spend pace stayed broadly similar.
      const currentDailyResults = current.results / 3;
      const baselineDailyResults = baseline.results / 7;
      const currentDailySpend = current.spend / 3;
      const baselineDailySpend = baseline.spend / 7;
      if (baselineDailyResults >= 1 && currentDailySpend >= baselineDailySpend * 0.8) {
        const drop = 1 - (currentDailyResults / baselineDailyResults);
        if (drop >= 0.3) {
          const key = "lead_volume_drop:account";
          const notify = await shouldNotify(config.meta_account_id, key);
          summary.alerts += 1;
          const alert = await saveAlert({ metaAccountId: config.meta_account_id, alertKey: key, alertType: "LEAD_VOLUME_DROP", severity: drop >= 0.5 ? "critical" : "warning", title: "Просадка обʼєму лідів", details: { currentDailyResults, baselineDailyResults, currentDailySpend, baselineDailySpend, drop }, notified: notify });
          if (notify) summary.notifications += await broadcast(config.meta_account_id, `📉 <b>ПРОСАДКА ОБʼЄМУ ЛІДІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nЛідів/день зараз: <b>${currentDailyResults.toFixed(1)}</b>\nBaseline: <b>${baselineDailyResults.toFixed(1)}</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\nSpend/день: <b>$${currentDailySpend.toFixed(2)}</b> vs $${baselineDailySpend.toFixed(2)}\nAlert ID: <code>${alert.id}</code>\n\nSpend не просів пропорційно — перевірте причину. Підтвердити: <code>/perf_ack ${alert.id}</code>`);
        }
      }

      // Manager-entered lead quality from the reporting sheet: B=all leads, G=target leads, H=spam, J=A-leads.
      const recentQuality = await readManagerQuality(config.report_file_id, managerDates(3, 1), config.report_start_date);
      const baseQuality = await readManagerQuality(config.report_file_id, managerDates(7, 4), config.report_start_date);
      if (recentQuality.totalLeads >= 10 && baseQuality.totalLeads >= 10) {
        const recentTargetRate = recentQuality.targetLeads / recentQuality.totalLeads;
        const baseTargetRate = baseQuality.targetLeads / baseQuality.totalLeads;
        const recentSpamRate = recentQuality.spam / recentQuality.totalLeads;
        const baseSpamRate = baseQuality.spam / baseQuality.totalLeads;
        const targetDrop = baseTargetRate > 0 ? 1 - recentTargetRate / baseTargetRate : 0;
        const spamGrowth = recentSpamRate - baseSpamRate;
        if (targetDrop >= 0.3 || spamGrowth >= 0.15) {
          const key = "lead_quality_drop:manager";
          const notify = await shouldNotify(config.meta_account_id, key);
          summary.alerts += 1;
          const alert = await saveAlert({ metaAccountId: config.meta_account_id, alertKey: key, alertType: "LEAD_QUALITY_DROP", severity: targetDrop >= 0.5 || spamGrowth >= 0.25 ? "critical" : "warning", title: "Просадка якості лідів", details: { recentTargetRate, baseTargetRate, recentSpamRate, baseSpamRate, targetDrop, spamGrowth, recentTotal: recentQuality.totalLeads }, notified: notify });
          if (notify) summary.notifications += await broadcast(config.meta_account_id, `🧪 <b>ПРОСАДКА ЯКОСТІ ЛІДІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nЦільові ліди: <b>${pct(recentTargetRate)}</b> vs ${pct(baseTargetRate)} baseline\nSpam: <b>${pct(recentSpamRate)}</b> vs ${pct(baseSpamRate)} baseline\nЗагальні ліди за останні 3 дні: <b>${recentQuality.totalLeads}</b>\nAlert ID: <code>${alert.id}</code>\n\nПеревірте якість трафіку/аудиторії/креативів. Підтвердити: <code>/perf_ack ${alert.id}</code>`);
        }
      }

      // Creative-level control uses a rolling 3-day window including today.
      const insights = await metaGraphAll<AdInsight>(`${objectId}/insights`, {
        level: "ad", fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,actions",
        time_range: JSON.stringify({ since: daysAgo(2), until: daysAgo(0) }), limit: "500",
      });
      const byAdset = new Map<string, Array<{ adId: string; adName: string; adsetName: string; spend: number; results: number }>>();
      for (const row of insights) {
        const key=row.adset_id||row.adset_name||"unknown"; const bucket=byAdset.get(key)||[];
        bucket.push({ adId: row.ad_id||row.ad_name||"unknown", adName: row.ad_name||"(unnamed ad)", adsetName: row.adset_name||"(unnamed ad set)", spend:Number(row.spend||0), results:results(row.actions) }); byAdset.set(key,bucket);
      }
      for (const [adsetId, creatives] of byAdset) {
        const productive=creatives.filter((item)=>item.results>0); if (productive.length<2) continue;
        const peerMedianCpl=median(productive.map((item)=>item.spend/item.results).filter((value)=>Number.isFinite(value)&&value>0)); if (!peerMedianCpl) continue;
        for (const creative of creatives) {
          const threshold=Math.max(Number(config.creative_waste_min_spend||15),peerMedianCpl*Number(config.creative_waste_cpl_multiplier||1.5));
          if (creative.results!==0||creative.spend<threshold) continue;
          const alertKey=`creative_waste:${adsetId}:${creative.adId}`; const old=await getAlert(config.meta_account_id,alertKey); const notify=await shouldNotify(config.meta_account_id,alertKey); summary.alerts+=1;
          const alert=await saveAlert({ metaAccountId:config.meta_account_id,alertKey,alertType:"CREATIVE_WASTE",severity:creative.spend>=threshold*1.5?"critical":"action_required",title:"Оптимізація потрібна — креативи",details:{ adsetId,adsetName:creative.adsetName,adId:creative.adId,adName:creative.adName,spend:creative.spend,results:creative.results,peerMedianCpl,threshold,notifiedSpend:notify?creative.spend:old?.details?.notifiedSpend||creative.spend },notified:notify });
          if (!notify) continue;
          const peers=productive.sort((a,b)=>(a.spend/a.results)-(b.spend/b.results)).slice(0,4).map((item)=>`• ${escapeTelegramHtml(item.adName)} — $${item.spend.toFixed(2)} / ${item.results} result / CPL $${(item.spend/item.results).toFixed(2)}`).join("\n");
          summary.notifications += await broadcast(config.meta_account_id, `⚡ <b>ОПТИМІЗАЦІЯ ПОТРІБНА — КРЕАТИВИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nAd set: <b>${escapeTelegramHtml(creative.adsetName)}</b>${tag?`\nТаргетолог: ${tag}`:""}\n\n🔴 <b>${escapeTelegramHtml(creative.adName)}</b>\nSpend: <b>$${creative.spend.toFixed(2)}</b>\nResults: <b>0</b>\n\nІнші креативи в цьому ad set:\n${peers}\n\nAlert ID: <code>${alert.id}</code>\nПерегляньте оптимізацію. Підтвердити: <code>/perf_ack ${alert.id}</code>`);
        }
      }
    } catch (error) {
      summary.errors.push(`${config.project_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try { summary.notifications += await escalateUnacknowledged(); }
  catch (error) { summary.errors.push(`escalation: ${error instanceof Error ? error.message : String(error)}`); }
  return summary;
}
