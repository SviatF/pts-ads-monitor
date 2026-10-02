import { listReportingConfigs, type ReportingConfig } from "@/lib/reporting-store";
import { listPerformanceMonitoringConfigs, type PerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";
import { performanceMention, sendPerformanceMessage } from "@/lib/performance-telegram";
import { ensurePerformanceAlertPersonalTask } from "@/lib/performance-personal-task-sync";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MANUAL_CLOSE_GRACE_MS = 6 * 60 * 60 * 1000;
const CHANGE_SILENCE_MS = 48 * 60 * 60 * 1000;
const MAX_PUSHES_PER_ACCOUNT_DAY = 2;

type MetaAction = { action_type?: string; value?: string };
type Insight = {
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  spend?: string; clicks?: string; impressions?: string; reach?: string; frequency?: string;
  actions?: MetaAction[];
};
type CampaignMeta = { id: string; name?: string; objective?: string; effective_status?: string; status?: string };
type MetaActivity = { event_time?: string; event_type?: string; object_name?: string; actor_name?: string; extra_data?: string };
type MetaAd = { id: string; name?: string; created_time?: string; campaign_id?: string };
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };
type AlertRecord = {
  id: number; meta_account_id: string; alert_key: string; alert_type: string; severity: string; title: string;
  details: Record<string, unknown>; first_seen_at: string; last_seen_at: string; last_notified_at: string | null;
  acknowledged_at: string | null; acknowledged_by: string | null; resolved_at: string | null; escalated_at: string | null;
};
type ManagerFunnel = { totalLeads: number; targetLeads: number; spam: number; aLeads: number; meetings: number; completedMeetings: number; sales: number };
type EffectiveConfig = PerformanceMonitoringConfig & { reporting: ReportingConfig | null };
type WindowMetric = { spend: number; results: number; clicks: number; impressions: number };
type CampaignPerformance = {
  id: string; name: string; objective: string; status: string; actionType: string | null;
  today: WindowMetric; recent3: WindowMetric; baseline7: WindowMetric;
};
type Diagnostic = {
  cplChange: number; cpmChange: number; ctrChange: number; crChange: number;
  reason: string; confidence: "HIGH" | "MEDIUM" | "LOW";
};

const ACTION_FAMILIES = {
  lead: ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead", "onsite_conversion.contact_website", "offsite_conversion.fb_pixel_contact", "contact"],
  message: ["onsite_conversion.messaging_conversation_started_7d", "messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply"],
  sale: ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.purchase"],
  traffic: ["landing_page_view", "link_click"],
};

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
async function optionalMetaGraphAll<T>(path: string, params: Record<string, string>) {
  try { return await metaGraphAll<T>(path, params); }
  catch (error) { console.warn("Optional Meta endpoint unavailable", path, error); return [] as T[]; }
}

function dateIso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return dateIso(d); }
function money(value: number) { return `$${value.toFixed(2)}`; }
function pctDelta(value: number) { return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`; }
function quoteSheet(title: string) { return `'${title.replace(/'/g, "''")}'`; }
function actionMap(actions?: MetaAction[]) { return new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)])); }
function resultFor(actions: MetaAction[] | undefined, actionType: string | null) { return actionType ? Number(actionMap(actions).get(actionType) || 0) : 0; }
function ratioChange(now: number, base: number) { return base > 0 ? now / base - 1 : 0; }
function cpl(m: WindowMetric) { return m.results > 0 ? m.spend / m.results : 0; }
function cpm(m: WindowMetric) { return m.impressions > 0 ? (m.spend / m.impressions) * 1000 : 0; }
function ctr(m: WindowMetric) { return m.impressions > 0 ? m.clicks / m.impressions : 0; }
function cr(m: WindowMetric) { return m.clicks > 0 ? m.results / m.clicks : 0; }

function configuredGoalFamily(config: EffectiveConfig) {
  const text = `${String(config.reporting?.goal_key || "").toLowerCase()} ${String(config.reporting?.goal_label || "").toLowerCase()}`;
  if (/(sale|purchase|продаж)/.test(text)) return "sale";
  if (/(message|messenger|direct|повідом)/.test(text)) return "message";
  if (/(lead|лід|contact)/.test(text)) return "lead";
  return null;
}
function objectiveFamily(objective: string, config: EffectiveConfig, available: Set<string>) {
  const obj = objective.toUpperCase();
  if (obj.includes("SALES")) return "sale";
  if (obj.includes("TRAFFIC") || obj === "LINK_CLICKS") return "traffic";
  if (obj.includes("LEADS")) {
    if (ACTION_FAMILIES.lead.some((a) => available.has(a))) return "lead";
    if (ACTION_FAMILIES.message.some((a) => available.has(a))) return "message";
    return "lead";
  }
  if (obj.includes("ENGAGEMENT") && ACTION_FAMILIES.message.some((a) => available.has(a))) return "message";
  return configuredGoalFamily(config) || "lead";
}
function selectStableAction(config: EffectiveConfig, objective: string, rows: Array<Insight | undefined>) {
  const available = new Set<string>();
  for (const row of rows) for (const action of row?.actions || []) if (action.action_type) available.add(action.action_type);
  const family = objectiveFamily(objective, config, available) as keyof typeof ACTION_FAMILIES;
  for (const action of ACTION_FAMILIES[family] || []) if (available.has(action)) return action;
  return null;
}
async function campaignInsights(objectId: string, since: string, until: string) {
  return metaGraphAll<Insight>(`${objectId}/insights`, {
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,clicks,impressions,actions",
    time_range: JSON.stringify({ since, until }), limit: "500",
  });
}
function metric(row: Insight | undefined, actionType: string | null): WindowMetric {
  return { spend: Number(row?.spend || 0), results: resultFor(row?.actions, actionType), clicks: Number(row?.clicks || 0), impressions: Number(row?.impressions || 0) };
}
async function buildCampaignPerformance(config: EffectiveConfig, objectId: string) {
  const [meta, todayRows, recent3Rows, baselineRows] = await Promise.all([
    metaGraphAll<CampaignMeta>(`${objectId}/campaigns`, { fields: "id,name,objective,effective_status,status", limit: "500" }),
    campaignInsights(objectId, daysAgo(0), daysAgo(0)),
    campaignInsights(objectId, daysAgo(3), daysAgo(1)),
    campaignInsights(objectId, daysAgo(10), daysAgo(4)),
  ]);
  const today = new Map(todayRows.map((r) => [String(r.campaign_id), r]));
  const recent3 = new Map(recent3Rows.map((r) => [String(r.campaign_id), r]));
  const baseline = new Map(baselineRows.map((r) => [String(r.campaign_id), r]));
  const allIds = new Set([...meta.map((m) => m.id), ...today.keys(), ...recent3.keys(), ...baseline.keys()]);
  const metaMap = new Map(meta.map((m) => [m.id, m]));
  const out: CampaignPerformance[] = [];
  for (const id of allIds) {
    const m = metaMap.get(id); const t = today.get(id); const r3 = recent3.get(id); const b = baseline.get(id);
    const objective = String(m?.objective || "UNKNOWN");
    const actionType = selectStableAction(config, objective, [t, r3, b]);
    out.push({ id, name: m?.name || t?.campaign_name || r3?.campaign_name || b?.campaign_name || id, objective, status: String(m?.effective_status || m?.status || "UNKNOWN"), actionType, today: metric(t, actionType), recent3: metric(r3, actionType), baseline7: metric(b, actionType) });
  }
  return out;
}

function diagnose(recent: WindowMetric, baseline: WindowMetric): Diagnostic {
  const cplChange = ratioChange(cpl(recent), cpl(baseline));
  const cpmChange = ratioChange(cpm(recent), cpm(baseline));
  const ctrChange = ratioChange(ctr(recent), ctr(baseline));
  const crChange = ratioChange(cr(recent), cr(baseline));
  let reason = "Змішаний сигнал / mixed signal";
  let confidence: Diagnostic["confidence"] = "LOW";
  if (crChange <= -0.25 && Math.abs(ctrChange) < 0.2) { reason = "Лендінг / форма / tracking / якість трафіку"; confidence = crChange <= -0.4 ? "HIGH" : "MEDIUM"; }
  else if (ctrChange <= -0.2 && crChange > -0.2) { reason = "Креатив / creative fatigue"; confidence = ctrChange <= -0.35 ? "HIGH" : "MEDIUM"; }
  else if (cpmChange >= 0.2 && ctrChange > -0.15 && crChange > -0.15) { reason = "Аукціон / сезонність / auction pressure"; confidence = cpmChange >= 0.35 ? "HIGH" : "MEDIUM"; }
  else if (ctrChange <= -0.2 && crChange <= -0.2) { reason = "Креатив + постклік / mixed creative & conversion"; confidence = "MEDIUM"; }
  return { cplChange, cpmChange, ctrChange, crChange, reason, confidence };
}

async function getAlert(metaAccountId: string, alertKey: string) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&alert_key=eq.${encodeURIComponent(alertKey)}&limit=1`);
  return rows[0] || null;
}
async function patchAlert(id: number, patch: Record<string, unknown>) {
  await supabaseRequest(`performance_alerts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
}
async function saveSignal(input: { metaAccountId: string; alertKey: string; alertType: string; severity: string; title: string; details: Record<string, unknown>; notify: boolean }) {
  const now = new Date().toISOString();
  const existing = await getAlert(input.metaAccountId, input.alertKey);
  if (existing?.resolved_at && Date.now() - new Date(existing.resolved_at).getTime() < MANUAL_CLOSE_GRACE_MS) return { alert: existing, blocked: true };
  const rows = await supabaseRequest<AlertRecord[]>("performance_alerts?on_conflict=meta_account_id,alert_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ meta_account_id: input.metaAccountId, alert_key: input.alertKey, alert_type: input.alertType, severity: input.severity, title: input.title, details: { ...(existing?.details || {}), ...input.details, logic_version: "performance_v4" }, last_seen_at: now, updated_at: now, resolved_at: null, ...(input.notify ? { last_notified_at: now, acknowledged_at: null, acknowledged_by: null, escalated_at: null } : {}) }),
  });
  return { alert: rows[0], blocked: false };
}
async function pushesToday(metaAccountId: string) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const rows = await supabaseRequest<Array<{ id: number }>>(`performance_alerts?select=id&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&last_notified_at=gte.${encodeURIComponent(midnight.toISOString())}&severity=in.(action_required,critical)&limit=20`);
  return rows.length;
}
async function sendActionable(config: EffectiveConfig, input: { key: string; type: string; severity: "action_required" | "critical"; title: string; body: string; details: Record<string, unknown>; emergency?: boolean }) {
  const existing = await getAlert(config.meta_account_id, input.key);
  if (existing?.resolved_at && Date.now() - new Date(existing.resolved_at).getTime() < MANUAL_CLOSE_GRACE_MS) return 0;
  const last = existing?.last_notified_at ? new Date(existing.last_notified_at).getTime() : 0;
  if (last && Date.now() - last < 12 * 60 * 60 * 1000) {
    const saved = await saveSignal({ metaAccountId: config.meta_account_id, alertKey: input.key, alertType: input.type, severity: input.severity, title: input.title, details: input.details, notify: false });
    if (!saved.blocked) {
      try { await ensurePerformanceAlertPersonalTask(config, saved.alert); } catch (error) { console.warn("Could not sync performance alert to personal tasks", error); }
    }
    return 0;
  }
  if (!input.emergency && await pushesToday(config.meta_account_id) >= MAX_PUSHES_PER_ACCOUNT_DAY) {
    const saved = await saveSignal({ metaAccountId: config.meta_account_id, alertKey: input.key, alertType: input.type, severity: input.severity, title: input.title, details: { ...input.details, push_suppressed: "daily_cap" }, notify: false });
    if (!saved.blocked) {
      try { await ensurePerformanceAlertPersonalTask(config, saved.alert); } catch (error) { console.warn("Could not sync performance alert to personal tasks", error); }
    }
    return 0;
  }
  const saved = await saveSignal({ metaAccountId: config.meta_account_id, alertKey: input.key, alertType: input.type, severity: input.severity, title: input.title, details: input.details, notify: true });
  if (saved.blocked) return 0;
  try {
    await ensurePerformanceAlertPersonalTask(config, saved.alert);
  } catch (error) {
    console.warn("Could not sync performance alert to personal tasks", error);
  }
  const tag = performanceMention(config.targetologist_telegram);
  await sendPerformanceMessage(`${input.body}${tag ? `\nТаргетолог / Targetologist: ${tag}` : ""}\nAlert ID: <code>${saved.alert.id}</code>\nЗакриття: у персональному PTS Tasks боті.`);
  return 1;
}
async function digestSignal(config: EffectiveConfig, input: { key: string; type: string; title: string; details: Record<string, unknown> }) {
  await saveSignal({ metaAccountId: config.meta_account_id, alertKey: input.key, alertType: input.type, severity: "info", title: input.title, details: { ...input.details, digest_only: true }, notify: false });
}

async function resolveOldLogic(config: EffectiveConfig) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&alert_type=in.(NO_OPTIMIZATION,CAMPAIGN_CPL_SPIKE,CAMPAIGN_VOLUME_DROP,CREATIVE_WASTE,ADSET_WASTE,CREATIVE_FATIGUE,CREATIVE_WINNER,CREATIVE_PIPELINE_EMPTY)&limit=200`);
  for (const row of rows) await patchAlert(row.id, { resolved_at: new Date().toISOString(), details: { ...(row.details || {}), resolved_reason: "replaced_by_performance_v4" } });
}

async function recentActivities(objectId: string) {
  return optionalMetaGraphAll<MetaActivity>(`${objectId}/activities`, { fields: "event_time,event_type,object_name,actor_name,extra_data", since: new Date(Date.now() - 72 * 3600000).toISOString(), limit: "500" });
}
function campaignRecentlyChanged(c: CampaignPerformance, activities: MetaActivity[]) {
  const cutoff = Date.now() - CHANGE_SILENCE_MS;
  return activities.some((a) => {
    const ts = a.event_time ? new Date(a.event_time).getTime() : 0;
    if (!ts || ts < cutoff) return false;
    const type = String(a.event_type || "").toLowerCase();
    if (!/(budget|bid|target|creative|campaign|adset|ad_set|ad_|update|create)/.test(type)) return false;
    const hay = `${a.object_name || ""} ${a.extra_data || ""}`.toLowerCase();
    return hay.includes(c.id.toLowerCase()) || (c.name.length >= 6 && hay.includes(c.name.toLowerCase()));
  });
}

function managerDates(fromDaysAgo: number, toDaysAgo: number) {
  const dates: Date[] = [];
  for (let d = fromDaysAgo; d >= toDaysAgo; d--) { const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - d); dates.push(date); }
  return dates;
}
async function readManagerFunnel(spreadsheetId: string, dates: Date[], reportingStartDate: string): Promise<ManagerFunnel> {
  const eligible = dates.filter((date) => dateIso(date) >= reportingStartDate);
  const zero = { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0, meetings: 0, completedMeetings: 0, sales: 0 };
  if (!eligible.length) return zero;
  const ranges = eligible.map((date) => { const period = periodForDate(date); const blocks = dailyBlocksForDays(periodLength(period)); const block = blocks[dayIndexInPeriod(date, period)]; const totalRow = block.dataStartRow + 16; return `${quoteSheet(period.title)}!B${totalRow}:O${totalRow}`; });
  const token = await getGoogleUserAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  ranges.forEach((range) => url.searchParams.append("ranges", range));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) return zero;
  const body = await response.json() as { valueRanges?: Array<{ values?: Array<Array<string | number>> }> };
  const total = { ...zero };
  for (const vr of body.valueRanges || []) { const row = vr.values?.[0] || []; total.totalLeads += Number(row[0] || 0); total.targetLeads += Number(row[5] || 0); total.spam += Number(row[6] || 0); total.aLeads += Number(row[8] || 0); total.meetings += Number(row[10] || 0); total.completedMeetings += Number(row[11] || 0); total.sales += Number(row[13] || 0); }
  return total;
}
async function routeSalesFunnelMessage(text: string) {
  const chatId = process.env.MANAGEMENT_TELEGRAM_CHAT_ID || process.env.PERFORMANCE_TELEGRAM_CHAT_ID;
  if (chatId) await sendTelegramToChat(chatId, text);
}

export async function runPerformanceMonitor() {
  const [monitoringRows, reportingRows] = await Promise.all([listPerformanceMonitoringConfigs(), listReportingConfigs()]);
  const reportingMap = new Map(reportingRows.map((item) => [item.meta_account_id, item]));
  const configs: EffectiveConfig[] = monitoringRows.filter((item) => item.enabled).map((item) => ({ ...item, reporting: reportingMap.get(item.meta_account_id) || null }));
  const summary = { projects: configs.length, alerts: 0, notifications: 0, errors: [] as string[] };

  for (const config of configs) {
    try {
      const objectId = config.meta_account_id.startsWith("act_") ? config.meta_account_id : `act_${config.meta_account_id}`;
      await resolveOldLogic(config);
      const [campaigns, activities] = await Promise.all([buildCampaignPerformance(config, objectId), recentActivities(objectId)]);
      const active = campaigns.filter((c) => c.status === "ACTIVE" || c.today.spend > 0 || c.recent3.spend > 0);
      const actionByCampaign = new Map(active.map((c) => [c.id, c.actionType]));

      for (const c of active) {
        if (!c.actionType) continue;
        const recentCpl = cpl(c.recent3), baselineCpl = cpl(c.baseline7);
        const diag = diagnose(c.recent3, c.baseline7);
        const recentDaily = c.recent3.results / 3, baselineDaily = c.baseline7.results / 7;
        const volumeDrop = baselineDaily > 0 ? 1 - recentDaily / baselineDaily : 0;
        const enoughData = c.recent3.results >= 5 && c.baseline7.results >= 7 && c.recent3.spend >= Math.max(20, baselineCpl * 3);
        const changed = campaignRecentlyChanged(c, activities);
        const todayRecovered = baselineDaily > 0 && c.today.results >= Math.max(2, baselineDaily * 0.8) && (c.today.results === 0 || baselineCpl === 0 || cpl(c.today) <= baselineCpl * 1.25);
        const cplBad = enoughData && diag.cplChange >= Number(config.cpl_warning_pct || 25) / 100;
        const volumeBad = c.recent3.spend / 3 >= (c.baseline7.spend / 7) * 0.8 && volumeDrop >= 0.4 && c.baseline7.results >= 7;

        if ((cplBad || volumeBad) && !changed && !todayRecovered) {
          const severe = (diag.cplChange >= Number(config.cpl_critical_pct || 40) / 100 && diag.cplChange >= 0.6) || volumeDrop >= 0.65;
          const diagnosisLine = `CPM ${pctDelta(diag.cpmChange)} · CTR ${pctDelta(diag.ctrChange)} · Click→Result CR ${pctDelta(diag.crChange)}`;
          const body = `${severe ? "🔴" : "🟠"} <b>PERFORMANCE ISSUE / ПОГІРШЕННЯ КАМПАНІЇ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(c.name)}</b>\nRecent 3d CPL: <b>${money(recentCpl)}</b> · Baseline 7d: <b>${money(baselineCpl)}</b>\nCPL: <b>${pctDelta(diag.cplChange)}</b> · Results/day: <b>${recentDaily.toFixed(1)}</b> vs ${baselineDaily.toFixed(1)}\n${diagnosisLine}\n\nЙмовірна причина / Likely cause: <b>${escapeTelegramHtml(diag.reason)}</b>\nConfidence: <b>${diag.confidence}</b>`;
          summary.notifications += await sendActionable(config, { key: `performance_incident_v4:${c.id}`, type: "PERFORMANCE_INCIDENT_V4", severity: severe ? "critical" : "action_required", title: `Performance issue — ${c.name}`, body, details: { campaignId: c.id, campaignName: c.name, actionType: c.actionType, recent3: c.recent3, baseline7: c.baseline7, diagnosis: diag, volumeDrop } });
          summary.alerts++;
        } else if ((cplBad || volumeBad) && (changed || todayRecovered)) {
          await digestSignal(config, { key: `performance_watch_v4:${c.id}`, type: "PERFORMANCE_WATCH_V4", title: `${todayRecovered ? "Відновлення" : "Watch після змін"} — ${c.name}`, details: { campaignId: c.id, changed, todayRecovered, diagnosis: diag, recent3: c.recent3, baseline7: c.baseline7, today: c.today } });
        }

        const emergencyThreshold = Math.max(20, baselineCpl > 0 ? baselineCpl * 3 : 30);
        if (c.today.results === 0 && c.today.spend >= emergencyThreshold) {
          summary.notifications += await sendActionable(config, { key: `emergency_no_results_v4:${c.id}`, type: "SPEND_WITHOUT_RESULTS_V4", severity: "critical", emergency: true, title: `Spend без results — ${c.name}`, body: `🚨 <b>EMERGENCY / SPEND БЕЗ RESULTS</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(c.name)}</b>\nСьогодні spend: <b>${money(c.today.spend)}</b> · Results: <b>0</b>${baselineCpl > 0 ? `\nНормальний 7d CPL: <b>${money(baselineCpl)}</b>` : ""}`, details: { campaignId: c.id, actionType: c.actionType, today: c.today, baselineCpl } });
          summary.alerts++;
        }
      }

      const [adsRecent, adsBase, adsetsRecent] = await Promise.all([
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "ad", fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,clicks,impressions,actions,frequency", time_range: JSON.stringify({ since: daysAgo(3), until: daysAgo(1) }), limit: "500" }),
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "ad", fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,clicks,impressions,actions,frequency", time_range: JSON.stringify({ since: daysAgo(10), until: daysAgo(4) }), limit: "500" }),
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "adset", fields: "campaign_id,campaign_name,adset_id,adset_name,spend,clicks,impressions,actions", time_range: JSON.stringify({ since: daysAgo(3), until: daysAgo(1) }), limit: "500" }),
      ]);
      const campaignMap = new Map(active.map((c) => [c.id, c]));
      const baseAds = new Map(adsBase.map((r) => [String(r.ad_id), r]));

      for (const row of adsRecent) {
        const campaignId = String(row.campaign_id || ""); const campaign = campaignMap.get(campaignId); const actionType = actionByCampaign.get(campaignId) || null;
        if (!campaign || !actionType) continue;
        const targetCpl = cpl(campaign.baseline7); if (targetCpl <= 0) continue;
        const spend = Number(row.spend || 0), results = resultFor(row.actions, actionType);
        if (results === 0 && spend >= targetCpl * 3) {
          summary.notifications += await sendActionable(config, { key: `creative_waste_v4:${row.ad_id || row.ad_name}`, type: "CREATIVE_WASTE_V4", severity: spend >= targetCpl * 5 ? "critical" : "action_required", title: `Creative waste — ${row.ad_name || "Без назви"}`, body: `⚡ <b>CREATIVE WASTE / КРЕАТИВ БЕЗ РЕЗУЛЬТАТУ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(row.campaign_name || "—")}</b>\nCreative: <b>${escapeTelegramHtml(row.ad_name || "Без назви")}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>0</b>\nОрієнтир CPL / target proxy: <b>${money(targetCpl)}</b>`, details: { campaignId, adId: row.ad_id, spend, results, targetCpl, actionType } });
          summary.alerts++;
        }
        const base = baseAds.get(String(row.ad_id));
        if (base && results >= 3) {
          const recentMetric: WindowMetric = { spend, results, clicks: Number(row.clicks || 0), impressions: Number(row.impressions || 0) };
          const baseMetric: WindowMetric = { spend: Number(base.spend || 0), results: resultFor(base.actions, actionType), clicks: Number(base.clicks || 0), impressions: Number(base.impressions || 0) };
          const freqRecent = Number(row.frequency || 0), freqBase = Number(base.frequency || 0);
          const ctrDrop = ratioChange(ctr(recentMetric), ctr(baseMetric)); const cplGrow = ratioChange(cpl(recentMetric), cpl(baseMetric)); const cpmGrow = ratioChange(cpm(recentMetric), cpm(baseMetric));
          const frequencyGrow = freqBase > 0 ? freqRecent / freqBase - 1 : 0;
          if (freqRecent >= 3 && frequencyGrow >= 0.15 && ctrDrop <= -0.2 && cplGrow >= 0.3 && cpmGrow >= -0.05) {
            summary.notifications += await sendActionable(config, { key: `creative_fatigue_v4:${row.ad_id || row.ad_name}`, type: "CREATIVE_FATIGUE_V4", severity: cplGrow >= 0.6 ? "critical" : "action_required", title: `Creative fatigue — ${row.ad_name || "Без назви"}`, body: `🎨 <b>CREATIVE FATIGUE / КРЕАТИВ ВИГОРАЄ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCreative: <b>${escapeTelegramHtml(row.ad_name || "Без назви")}</b>\nFrequency: <b>${freqBase.toFixed(1)} → ${freqRecent.toFixed(1)}</b>\nCTR: <b>${pctDelta(ctrDrop)}</b> · CPM: <b>${pctDelta(cpmGrow)}</b> · CPL: <b>${pctDelta(cplGrow)}</b>\n\nКомбінація сигналів підтверджує fatigue.`, details: { campaignId, adId: row.ad_id, frequencyGrow, ctrDrop, cpmGrow, cplGrow } });
            summary.alerts++;
          }
          if (results >= 5 && cpl(recentMetric) <= targetCpl * 0.65) await digestSignal(config, { key: `creative_winner_v4:${row.ad_id || row.ad_name}`, type: "CREATIVE_WINNER_V4", title: `Winner — ${row.ad_name || "Без назви"}`, details: { campaignId, adId: row.ad_id, results, cpl: cpl(recentMetric), targetCpl } });
        }
      }

      for (const row of adsetsRecent) {
        const campaignId = String(row.campaign_id || ""); const campaign = campaignMap.get(campaignId); const actionType = actionByCampaign.get(campaignId) || null;
        if (!campaign || !actionType) continue;
        const targetCpl = cpl(campaign.baseline7); if (targetCpl <= 0) continue;
        const spend = Number(row.spend || 0), results = resultFor(row.actions, actionType), rowCpl = results > 0 ? spend / results : 0;
        const zeroWaste = results === 0 && spend >= targetCpl * 2.5;
        const expensive = results >= 3 && rowCpl >= targetCpl * 2 && spend >= targetCpl * 3;
        if (zeroWaste || expensive) {
          summary.notifications += await sendActionable(config, { key: `adset_issue_v4:${row.adset_id || row.adset_name}`, type: "ADSET_ISSUE_V4", severity: zeroWaste && spend >= targetCpl * 4 ? "critical" : "action_required", title: `Ad set issue — ${row.adset_name || "Без назви"}`, body: `⚡ <b>AD SET ISSUE / ПОТРЕБУЄ ПЕРЕВІРКИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(row.campaign_name || "—")}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name || "—")}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>${results}</b>${results > 0 ? ` · CPL: <b>${money(rowCpl)}</b>` : ""}\nTarget proxy / baseline CPL: <b>${money(targetCpl)}</b>`, details: { campaignId, adsetId: row.adset_id, spend, results, rowCpl, targetCpl } });
          summary.alerts++;
        }
      }

      const total7dSpend = active.reduce((sum, c) => sum + c.baseline7.spend, 0);
      if (total7dSpend >= 200) {
        const metaAds = await optionalMetaGraphAll<MetaAd>(`${objectId}/ads`, { fields: "id,name,created_time,campaign_id", limit: "500" });
        const newest = metaAds.map((ad) => ad.created_time ? new Date(ad.created_time).getTime() : 0).reduce((a, b) => Math.max(a, b), 0);
        const ageDays = newest ? (Date.now() - newest) / 86400000 : 0;
        if (newest && ageDays >= 10) await digestSignal(config, { key: "creative_pipeline_v4", type: "CREATIVE_PIPELINE_V4", title: "Потрібні нові креативи / Creative pipeline", details: { ageDays, total7dSpend } });
      }

      if (config.reporting?.report_file_id && config.reporting.report_file_id !== "MONITOR_ONLY") {
        const recent = await readManagerFunnel(config.reporting.report_file_id, managerDates(3, 1), config.reporting.report_start_date);
        const base = await readManagerFunnel(config.reporting.report_file_id, managerDates(7, 4), config.reporting.report_start_date);
        if (recent.aLeads >= 5 && base.aLeads >= 5) {
          const now = recent.completedMeetings / recent.aLeads, prev = base.completedMeetings / base.aLeads, drop = prev > 0 ? 1 - now / prev : 0;
          if (drop >= 0.35) await routeSalesFunnelMessage(`📞 <b>SALES FUNNEL / A-LEAD → MEETING ПРОСІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nRecent: <b>${Math.round(now * 100)}%</b> · Baseline: <b>${Math.round(prev * 100)}%</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\n\nOwner: Sales / Account Management, не Targetologist.`);
        }
        if (recent.completedMeetings >= 4 && base.completedMeetings >= 4) {
          const now = recent.sales / recent.completedMeetings, prev = base.sales / base.completedMeetings, drop = prev > 0 ? 1 - now / prev : 0;
          if (drop >= 0.35) await routeSalesFunnelMessage(`💰 <b>SALES FUNNEL / MEETING → SALE ПРОСІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nRecent: <b>${Math.round(now * 100)}%</b> · Baseline: <b>${Math.round(prev * 100)}%</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\n\nOwner: Sales / Account Management, не Targetologist.`);
        }
      }
    } catch (error) {
      summary.errors.push(`${config.project_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
