import { listReportingConfigs, type ReportingConfig } from "@/lib/reporting-store";
import { listPerformanceMonitoringConfigs, type PerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";
import { performanceMention, sendPerformanceMessage } from "@/lib/performance-telegram";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaAction = { action_type?: string; value?: string };
type Insight = {
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  spend?: string; clicks?: string; impressions?: string; reach?: string; frequency?: string;
  actions?: MetaAction[];
};
type MetaAd = { id: string; name?: string; created_time?: string; effective_status?: string; adset_id?: string };
type MetaActivity = { event_time?: string; event_type?: string; object_name?: string; actor_name?: string; extra_data?: string };
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

type ManagerFunnel = {
  totalLeads: number;
  targetLeads: number;
  spam: number;
  aLeads: number;
  meetings: number;
  completedMeetings: number;
  sales: number;
};

type EffectiveConfig = PerformanceMonitoringConfig & { reporting: ReportingConfig | null };

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

async function optionalMetaGraphAll<T>(path: string, params: Record<string, string>) {
  try { return await metaGraphAll<T>(path, params); }
  catch (error) {
    console.warn("Optional Meta endpoint unavailable", path, error);
    return [] as T[];
  }
}

function results(actions?: MetaAction[]) {
  const map = new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)]));
  for (const type of RESULT_ACTION_PRIORITY) if (map.has(type)) return Number(map.get(type) || 0);
  return 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function dateIso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return dateIso(d); }
function pct(value: number) { return `${Math.round(value * 100)}%`; }
function money(value: number) { return `$${value.toFixed(2)}`; }
function quoteSheet(title: string) { return `'${title.replace(/'/g, "''")}'`; }

function kyivHour() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === "hour")?.value || 0);
}

async function getAlert(metaAccountId: string, alertKey: string) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&alert_key=eq.${encodeURIComponent(alertKey)}&limit=1`);
  return rows[0] || null;
}

async function shouldNotify(metaAccountId: string, alertKey: string, cooldownHours = 12) {
  const current = await getAlert(metaAccountId, alertKey);
  if (!current?.last_notified_at) return true;
  return Date.now() - new Date(current.last_notified_at).getTime() >= cooldownHours * 60 * 60 * 1000;
}

async function saveAlert(input: {
  metaAccountId: string;
  alertKey: string;
  alertType: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  notified: boolean;
}) {
  const now = new Date().toISOString();
  const existing = await getAlert(input.metaAccountId, input.alertKey);
  const rows = await supabaseRequest<AlertRecord[]>("performance_alerts?on_conflict=meta_account_id,alert_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      meta_account_id: input.metaAccountId,
      alert_key: input.alertKey,
      alert_type: input.alertType,
      severity: input.severity,
      title: input.title,
      details: { ...(existing?.details || {}), ...input.details },
      last_seen_at: now,
      updated_at: now,
      resolved_at: null,
      ...(input.notified ? { last_notified_at: now, acknowledged_at: null, acknowledged_by: null, escalated_at: null } : {}),
    }),
  });
  return rows[0];
}

async function patchAlert(id: number, patch: Record<string, unknown>) {
  await supabaseRequest(`performance_alerts?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function emitAlert(config: EffectiveConfig, input: {
  key: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  details: Record<string, unknown>;
  cooldownHours?: number;
}) {
  const notify = await shouldNotify(config.meta_account_id, input.key, input.cooldownHours ?? 12);
  const alert = await saveAlert({
    metaAccountId: config.meta_account_id,
    alertKey: input.key,
    alertType: input.type,
    severity: input.severity,
    title: input.title,
    details: input.details,
    notified: notify,
  });
  if (!notify) return { alert, notified: 0 };
  const tag = performanceMention(config.targetologist_telegram);
  const message = `${input.body}${tag ? `\nТаргетолог: ${tag}` : ""}\nAlert ID: <code>${alert.id}</code>${["warning", "action_required", "critical"].includes(input.severity) ? `\nПідтвердити: <code>/perf_ack ${alert.id}</code>` : ""}`;
  await sendPerformanceMessage(message);
  return { alert, notified: 1 };
}

async function accountWindow(objectId: string, since: string, until: string) {
  const rows = await metaGraphAll<Insight>(`${objectId}/insights`, {
    level: "account",
    fields: "spend,clicks,actions",
    time_range: JSON.stringify({ since, until }),
    limit: "20",
  });
  return {
    spend: rows.reduce((sum, row) => sum + Number(row.spend || 0), 0),
    results: rows.reduce((sum, row) => sum + results(row.actions), 0),
    clicks: rows.reduce((sum, row) => sum + Number(row.clicks || 0), 0),
  };
}

function managerDates(fromDaysAgo: number, toDaysAgo: number) {
  const dates: Date[] = [];
  for (let d = fromDaysAgo; d >= toDaysAgo; d -= 1) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - d);
    dates.push(date);
  }
  return dates;
}

async function readManagerFunnel(spreadsheetId: string, dates: Date[], reportingStartDate: string): Promise<ManagerFunnel> {
  const eligible = dates.filter((date) => dateIso(date) >= reportingStartDate);
  const zero = { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0, meetings: 0, completedMeetings: 0, sales: 0 };
  if (!eligible.length) return zero;
  const ranges = eligible.map((date) => {
    const period = periodForDate(date);
    const blocks = dailyBlocksForDays(periodLength(period));
    const block = blocks[dayIndexInPeriod(date, period)];
    const totalRow = block.dataStartRow + 16;
    return `${quoteSheet(period.title)}!B${totalRow}:O${totalRow}`;
  });
  const token = await getGoogleUserAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  ranges.forEach((range) => url.searchParams.append("ranges", range));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) return zero;
  const body = await response.json() as { valueRanges?: Array<{ values?: Array<Array<string | number>> }> };
  const total = { ...zero };
  for (const valueRange of body.valueRanges || []) {
    const row = valueRange.values?.[0] || [];
    total.totalLeads += Number(row[0] || 0); // B
    total.targetLeads += Number(row[5] || 0); // G
    total.spam += Number(row[6] || 0); // H
    total.aLeads += Number(row[8] || 0); // J
    total.meetings += Number(row[10] || 0); // L
    total.completedMeetings += Number(row[11] || 0); // M
    total.sales += Number(row[13] || 0); // O
  }
  return total;
}

async function optimizationActivities(objectId: string, sinceIso: string) {
  const rows = await optionalMetaGraphAll<MetaActivity>(`${objectId}/activities`, {
    fields: "event_time,event_type,object_name,actor_name,extra_data",
    since: sinceIso,
    limit: "200",
  });
  return rows.filter((row) => {
    const type = String(row.event_type || "").toLowerCase();
    return /(campaign|adset|ad_set|ad_|budget|bid|status|target|creative|update|create|pause)/.test(type);
  });
}

async function resolveRecoveredAlerts(config: EffectiveConfig, current: { spend: number; results: number; clicks: number }, baseline: { spend: number; results: number; clicks: number }) {
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&alert_type=in.(CPL_SPIKE,SPEND_WITHOUT_RESULTS,LEAD_VOLUME_DROP)&limit=20`);
  let notifications = 0;
  const currentCpl = current.results > 0 ? current.spend / current.results : 0;
  const baselineCpl = baseline.results > 0 ? baseline.spend / baseline.results : 0;
  const currentDaily = current.results / 3;
  const baselineDaily = baseline.results / 7;
  for (const alert of rows) {
    let recovered = false;
    if (alert.alert_type === "CPL_SPIKE" && currentCpl > 0 && baselineCpl > 0 && currentCpl <= baselineCpl * 1.1) recovered = true;
    if (alert.alert_type === "SPEND_WITHOUT_RESULTS" && current.results > 0) recovered = true;
    if (alert.alert_type === "LEAD_VOLUME_DROP" && baselineDaily > 0 && currentDaily >= baselineDaily * 0.9) recovered = true;
    if (!recovered) continue;
    await sendPerformanceMessage(`🟢 <b>RECOVERED — ПОКАЗНИК ПОВЕРНУВСЯ В НОРМУ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nПопередня проблема: <b>${escapeTelegramHtml(alert.title)}</b>\n${currentCpl > 0 ? `CPL зараз: <b>${money(currentCpl)}</b>\n` : ""}Results за 3 дні: <b>${current.results}</b>`);
    await patchAlert(alert.id, { resolved_at: new Date().toISOString() });
    notifications += 1;
  }
  return notifications;
}

async function postOptimizationChecks(config: EffectiveConfig, objectId: string) {
  const cutoff = new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&acknowledged_at=not.is.null&acknowledged_at=lte.${encodeURIComponent(cutoff)}&severity=in.(warning,action_required,critical)&limit=20`);
  let notifications = 0;
  for (const original of rows) {
    const checkKey = `post_check:${original.id}`;
    if (await getAlert(config.meta_account_id, checkKey)) continue;
    const recent = await accountWindow(objectId, daysAgo(1), daysAgo(1));
    const recentCpl = recent.results > 0 ? recent.spend / recent.results : 0;
    const beforeCpl = Number(original.details?.currentCpl || original.details?.baselineCpl || 0);
    const beforeDaily = Number(original.details?.currentDailyResults || 0);
    const improvedByCpl = beforeCpl > 0 && recentCpl > 0 && recentCpl <= beforeCpl * 0.85;
    const improvedByVolume = beforeDaily > 0 && recent.results >= beforeDaily * 1.15;
    const restoredResults = original.alert_type === "SPEND_WITHOUT_RESULTS" && recent.results > 0;
    const improved = improvedByCpl || improvedByVolume || restoredResults;
    const severity = improved ? "info" : "warning";
    const title = improved ? "Optimization worked" : "Optimization не дала покращення";
    const emitted = await emitAlert(config, {
      key: checkKey,
      type: "POST_OPTIMIZATION_CHECK",
      severity,
      title,
      cooldownHours: 720,
      details: { originalAlertId: original.id, recentCpl, recentResults: recent.results, improved },
      body: `${improved ? "✅" : "🔴"} <b>${improved ? "OPTIMIZATION WORKED" : "OPTIMIZATION НЕ ДАЛА ПОКРАЩЕННЯ"}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nПочатковий alert: <code>#${original.id}</code> · ${escapeTelegramHtml(original.title)}\nResults за вчора: <b>${recent.results}</b>${recentCpl > 0 ? `\nCPL за вчора: <b>${money(recentCpl)}</b>` : ""}\n${improved ? "Зміни дали позитивну динаміку." : "Проблема потребує повторного перегляду."}`,
    });
    notifications += emitted.notified;
  }
  return notifications;
}

async function escalateUnacknowledged(configs: EffectiveConfig[]) {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&resolved_at=is.null&acknowledged_at=is.null&escalated_at=is.null&severity=in.(warning,action_required,critical)&last_notified_at=lte.${encodeURIComponent(cutoff)}&last_seen_at=gte.${encodeURIComponent(fresh)}&order=last_notified_at.asc&limit=100`);
  let notifications = 0;
  for (const alert of rows) {
    const config = configs.find((item) => item.meta_account_id === alert.meta_account_id);
    if (!config) continue;
    const tag = performanceMention(config.targetologist_telegram);
    const spend = Number(alert.details?.spend || alert.details?.currentSpend || 0);
    const notifiedSpend = Number(alert.details?.notifiedSpend || 0);
    const extraSpend = spend > notifiedSpend && notifiedSpend > 0 ? spend - notifiedSpend : 0;
    await sendPerformanceMessage(`🚨 <b>ALERT НЕ ОПРАЦЬОВАНИЙ 2+ ГОДИНИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${tag ? `\nТаргетолог: ${tag}` : ""}\nПроблема: <b>${escapeTelegramHtml(alert.title)}</b>\nAlert ID: <code>${alert.id}</code>${extraSpend > 0 ? `\nПісля першого попередження витрачено ще: <b>${money(extraSpend)}</b>` : ""}\n\nПідтвердьте: <code>/perf_ack ${alert.id}</code> або закрийте: <code>/perf_done ${alert.id}</code>`);
    await patchAlert(alert.id, { escalated_at: new Date().toISOString() });
    notifications += 1;
  }
  return notifications;
}

export async function runPerformanceMonitor() {
  const [monitoringRows, reportingRows] = await Promise.all([listPerformanceMonitoringConfigs(), listReportingConfigs()]);
  const reportingMap = new Map(reportingRows.map((item) => [item.meta_account_id, item]));
  const configs: EffectiveConfig[] = monitoringRows
    .filter((item) => item.enabled)
    .map((item) => ({ ...item, reporting: reportingMap.get(item.meta_account_id) || null }));

  const summary = { projects: configs.length, alerts: 0, notifications: 0, errors: [] as string[] };

  for (const config of configs) {
    try {
      const objectId = config.meta_account_id.startsWith("act_") ? config.meta_account_id : `act_${config.meta_account_id}`;
      const current = await accountWindow(objectId, daysAgo(3), daysAgo(1));
      const baseline = await accountWindow(objectId, daysAgo(10), daysAgo(4));
      const currentCpl = current.results > 0 ? current.spend / current.results : 0;
      const baselineCpl = baseline.results > 0 ? baseline.spend / baseline.results : 0;
      const currentDailyResults = current.results / 3;
      const baselineDailyResults = baseline.results / 7;
      const currentDailySpend = current.spend / 3;
      const baselineDailySpend = baseline.spend / 7;

      // 1–2. CPL WARNING / CRITICAL
      if (baselineCpl > 0 && current.results >= 3 && current.spend >= baselineCpl * 3) {
        const growth = ((currentCpl / baselineCpl) - 1) * 100;
        if (growth >= Number(config.cpl_warning_pct || 30)) {
          const critical = growth >= Number(config.cpl_critical_pct || 50);
          const emitted = await emitAlert(config, {
            key: `cpl_spike:${critical ? "critical" : "warning"}`,
            type: "CPL_SPIKE",
            severity: critical ? "critical" : "warning",
            title: critical ? "CPL critical" : "CPL warning",
            details: { currentCpl, baselineCpl, growth, currentSpend: current.spend, notifiedSpend: current.spend },
            body: `${critical ? "🔴" : "🟠"} <b>${critical ? "CPL CRITICAL" : "CPL WARNING"}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCPL зараз: <b>${money(currentCpl)}</b>\nBaseline CPL: <b>${money(baselineCpl)}</b>\nЗміна: <b>+${growth.toFixed(0)}%</b>\nSpend: <b>${money(current.spend)}</b> · Results: <b>${current.results}</b>\n\nПеревірте оптимізацію кабінету.`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
      }

      // 3. Spend без результатів
      if (baselineCpl > 0 && current.results === 0 && current.spend >= baselineCpl * 2) {
        const emitted = await emitAlert(config, {
          key: "spend_without_results:account",
          type: "SPEND_WITHOUT_RESULTS",
          severity: "critical",
          title: "Spend без результатів",
          details: { currentSpend: current.spend, baselineCpl, notifiedSpend: current.spend },
          body: `🚨 <b>SPEND БЕЗ РЕЗУЛЬТАТІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nSpend: <b>${money(current.spend)}</b>\nResults: <b>0</b>\nПопередній CPL: <b>${money(baselineCpl)}</b>\n\nПотрібна перевірка кабінету.`,
        });
        summary.alerts += 1; summary.notifications += emitted.notified;
      }

      // 4. Просадка обʼєму лідів
      if (baselineDailyResults >= 1 && currentDailySpend >= baselineDailySpend * 0.8) {
        const drop = 1 - currentDailyResults / baselineDailyResults;
        if (drop >= 0.3) {
          const emitted = await emitAlert(config, {
            key: "lead_volume_drop:account",
            type: "LEAD_VOLUME_DROP",
            severity: drop >= 0.5 ? "critical" : "warning",
            title: "Просадка обʼєму лідів",
            details: { currentDailyResults, baselineDailyResults, currentDailySpend, baselineDailySpend, drop },
            body: `📉 <b>ПРОСАДКА ОБʼЄМУ ЛІДІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЛідів/день зараз: <b>${currentDailyResults.toFixed(1)}</b>\nBaseline: <b>${baselineDailyResults.toFixed(1)}</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\nSpend/день: <b>${money(currentDailySpend)}</b> vs ${money(baselineDailySpend)}\n\nSpend не просів пропорційно — перевірте причину.`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
      }

      // Click → Lead: без CTR/CPC, дивимось тільки конверсію кліку в результат.
      if (current.clicks >= 50 && baseline.clicks >= 100) {
        const currentCr = current.results / current.clicks;
        const baselineCr = baseline.results / baseline.clicks;
        const drop = baselineCr > 0 ? 1 - currentCr / baselineCr : 0;
        if (drop >= 0.35) {
          const emitted = await emitAlert(config, {
            key: "click_to_lead_drop:account",
            type: "CLICK_TO_LEAD_DROP",
            severity: drop >= 0.55 ? "critical" : "warning",
            title: "Просадка Click → Lead",
            details: { currentCr, baselineCr, currentClicks: current.clicks, currentResults: current.results, drop },
            body: `🌐 <b>ПРОСАДКА CLICK → LEAD</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКонверсія зараз: <b>${pct(currentCr)}</b>\nBaseline: <b>${pct(baselineCr)}</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\nClicks: <b>${current.clicks}</b> · Results: <b>${current.results}</b>\n\nРеклама приводить трафік, але він гірше конвертується в lead. Перевірте форму / квіз / сайт / оффер / tracking.`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
      }

      // Meta hierarchy: creative / adset / campaign.
      const [ads, adsets, campaigns] = await Promise.all([
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "ad", fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,actions,frequency", time_range: JSON.stringify({ since: daysAgo(2), until: daysAgo(0) }), limit: "500" }),
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "adset", fields: "campaign_id,campaign_name,adset_id,adset_name,spend,actions", time_range: JSON.stringify({ since: daysAgo(2), until: daysAgo(0) }), limit: "500" }),
        metaGraphAll<Insight>(`${objectId}/insights`, { level: "campaign", fields: "campaign_id,campaign_name,spend,actions", time_range: JSON.stringify({ since: daysAgo(2), until: daysAgo(0) }), limit: "500" }),
      ]);

      // 5. Creative waste + winner + winner not scaled + fatigue by lead efficiency/frequency.
      const adsByAdset = new Map<string, Insight[]>();
      for (const row of ads) {
        const key = row.adset_id || row.adset_name || "unknown";
        const bucket = adsByAdset.get(key) || []; bucket.push(row); adsByAdset.set(key, bucket);
      }
      for (const [adsetId, rows] of adsByAdset) {
        const productive = rows.filter((row) => results(row.actions) > 0);
        if (productive.length >= 2) {
          const peerMedianCpl = median(productive.map((row) => Number(row.spend || 0) / results(row.actions)).filter((v) => v > 0));
          const adsetSpend = rows.reduce((sum, row) => sum + Number(row.spend || 0), 0);
          for (const row of rows) {
            const spend = Number(row.spend || 0); const res = results(row.actions); const cpl = res > 0 ? spend / res : 0;
            const name = row.ad_name || "Без назви";
            const threshold = Math.max(Number(config.creative_waste_min_spend || 15), peerMedianCpl * Number(config.creative_waste_cpl_multiplier || 1.5));
            if (res === 0 && spend >= threshold) {
              const emitted = await emitAlert(config, {
                key: `creative_waste:${adsetId}:${row.ad_id || name}`,
                type: "CREATIVE_WASTE",
                severity: spend >= threshold * 1.5 ? "critical" : "action_required",
                title: "Оптимізація потрібна — креативи",
                details: { adsetId, adsetName: row.adset_name, adId: row.ad_id, adName: name, spend, results: res, peerMedianCpl, threshold, notifiedSpend: spend },
                body: `⚡ <b>ОПТИМІЗАЦІЯ ПОТРІБНА — КРЕАТИВИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name || "—")}</b>\n🔴 ${escapeTelegramHtml(name)} — <b>${money(spend)} / 0 results</b>\nMedian CPL інших креативів: <b>${money(peerMedianCpl)}</b>\n\nПерегляньте оптимізацію в цьому ad set.`,
              });
              summary.alerts += 1; summary.notifications += emitted.notified;
            }
            if (res >= 5 && peerMedianCpl > 0 && cpl <= peerMedianCpl * 0.6) {
              const emitted = await emitAlert(config, {
                key: `creative_winner:${adsetId}:${row.ad_id || name}`,
                type: "CREATIVE_WINNER",
                severity: "info",
                title: "Creative winner detected",
                cooldownHours: 36,
                details: { adsetId, adName: name, spend, results: res, cpl, peerMedianCpl },
                body: `🏆 <b>WINNER DETECTED — КРЕАТИВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name || "—")}</b>\nКреатив: <b>${escapeTelegramHtml(name)}</b>\nResults: <b>${res}</b> · CPL: <b>${money(cpl)}</b>\nMedian інших: <b>${money(peerMedianCpl)}</b>\n\nПеревірте можливість акуратного масштабування winner-а.`,
              });
              summary.alerts += 1; summary.notifications += emitted.notified;
              const share = adsetSpend > 0 ? spend / adsetSpend : 0;
              if (adsetSpend >= 100 && share < 0.15) {
                const scaled = await emitAlert(config, {
                  key: `winner_not_scaled:${adsetId}:${row.ad_id || name}`,
                  type: "WINNER_NOT_SCALED",
                  severity: "action_required",
                  title: "Winner не використаний",
                  cooldownHours: 24,
                  details: { adName: name, cpl, share, spend, adsetSpend },
                  body: `⚠️ <b>WINNER НЕ ВИКОРИСТАНИЙ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКреатив: <b>${escapeTelegramHtml(name)}</b>\nCPL: <b>${money(cpl)}</b>\nЧастка spend у ad set: <b>${pct(share)}</b>\n\nСильний креатив отримує мало бюджету — перевірте розподіл spend.`,
                });
                summary.alerts += 1; summary.notifications += scaled.notified;
              }
            }
            const frequency = Number(row.frequency || 0);
            if (res >= 2 && frequency >= 3.5 && peerMedianCpl > 0 && cpl >= peerMedianCpl * 1.4) {
              const emitted = await emitAlert(config, {
                key: `creative_fatigue:${row.ad_id || name}`,
                type: "CREATIVE_FATIGUE",
                severity: "warning",
                title: "Креатив вигорає",
                cooldownHours: 24,
                details: { adName: name, frequency, cpl, peerMedianCpl, results: res },
                body: `🎨 <b>КРЕАТИВ ВИГОРЯЄ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКреатив: <b>${escapeTelegramHtml(name)}</b>\nFrequency: <b>${frequency.toFixed(1)}</b>\nCPL: <b>${money(cpl)}</b> vs median ${money(peerMedianCpl)}\n\nПотрібен новий creative test, а не нескінченне дотискання старого.`,
              });
              summary.alerts += 1; summary.notifications += emitted.notified;
            }
          }
        }
      }

      // 6. Ad set waste — порівнюємо adsets у межах однієї campaign.
      const adsetsByCampaign = new Map<string, Insight[]>();
      for (const row of adsets) {
        const key = row.campaign_id || row.campaign_name || "unknown";
        const bucket = adsetsByCampaign.get(key) || []; bucket.push(row); adsetsByCampaign.set(key, bucket);
      }
      for (const [campaignId, rows] of adsetsByCampaign) {
        const productive = rows.filter((row) => results(row.actions) > 0);
        if (productive.length < 2) continue;
        const med = median(productive.map((row) => Number(row.spend || 0) / results(row.actions)).filter((v) => v > 0));
        for (const row of rows) {
          const spend = Number(row.spend || 0); const res = results(row.actions); const cpl = res > 0 ? spend / res : Infinity;
          if (spend >= Math.max(30, med * 3) && ((res === 0 && spend >= med * 2) || cpl >= med * 1.8)) {
            const emitted = await emitAlert(config, {
              key: `adset_waste:${campaignId}:${row.adset_id || row.adset_name}`,
              type: "ADSET_WASTE",
              severity: cpl >= med * 2.5 || res === 0 ? "critical" : "action_required",
              title: "Ad set потребує оптимізації",
              details: { adsetName: row.adset_name, spend, results: res, cpl: Number.isFinite(cpl) ? cpl : 0, peerMedianCpl: med },
              body: `⚡ <b>AD SET ПОТРЕБУЄ ОПТИМІЗАЦІЇ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name || "—")}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>${res}</b>${Number.isFinite(cpl) ? `\nCPL: <b>${money(cpl)}</b>` : ""}\nMedian інших adsets: <b>${money(med)}</b>\n\nПеревірте перерозподіл бюджету / аудиторію / структуру.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }
      }

      // 7. Campaign waste + концентрація бюджету.
      const productiveCampaigns = campaigns.filter((row) => results(row.actions) > 0);
      const campaignMedian = median(productiveCampaigns.map((row) => Number(row.spend || 0) / results(row.actions)).filter((v) => v > 0));
      const totalCampaignSpend = campaigns.reduce((sum, row) => sum + Number(row.spend || 0), 0);
      for (const row of campaigns) {
        const spend = Number(row.spend || 0); const res = results(row.actions); const cpl = res > 0 ? spend / res : Infinity;
        if (productiveCampaigns.length >= 2 && campaignMedian > 0 && spend >= Math.max(50, campaignMedian * 3) && ((res === 0 && spend >= campaignMedian * 2) || cpl >= campaignMedian * 1.8)) {
          const emitted = await emitAlert(config, {
            key: `campaign_waste:${row.campaign_id || row.campaign_name}`,
            type: "CAMPAIGN_WASTE",
            severity: res === 0 || cpl >= campaignMedian * 2.5 ? "critical" : "action_required",
            title: "Campaign потребує оптимізації",
            details: { campaignName: row.campaign_name, spend, results: res, cpl: Number.isFinite(cpl) ? cpl : 0, median: campaignMedian },
            body: `🔥 <b>CAMPAIGN WASTE — ПОТРІБНА ОПТИМІЗАЦІЯ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(row.campaign_name || "—")}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>${res}</b>${Number.isFinite(cpl) ? `\nCPL: <b>${money(cpl)}</b>` : ""}\nMedian інших campaigns: <b>${money(campaignMedian)}</b>`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
        const share = totalCampaignSpend > 0 ? spend / totalCampaignSpend : 0;
        if (campaigns.filter((item) => Number(item.spend || 0) > 0).length >= 2 && totalCampaignSpend >= 150 && share >= 0.8) {
          const emitted = await emitAlert(config, {
            key: `budget_concentration:${row.campaign_id || row.campaign_name}`,
            type: "BUDGET_CONCENTRATION",
            severity: "warning",
            title: "Концентрація бюджету",
            cooldownHours: 24,
            details: { campaignName: row.campaign_name, share, spend, totalCampaignSpend },
            body: `⚖️ <b>КОНЦЕНТРАЦІЯ БЮДЖЕТУ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCampaign: <b>${escapeTelegramHtml(row.campaign_name || "—")}</b>\nЧастка spend: <b>${pct(share)}</b>\n\nЦе не завжди проблема, але перевірте, чи концентрація бюджету свідома.`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
      }

      // 8. Дисципліна оптимізації: no optimization / over-optimization.
      const growth = baselineCpl > 0 && currentCpl > 0 ? (currentCpl / baselineCpl - 1) * 100 : 0;
      const [activities72h, activities24h] = await Promise.all([
        optimizationActivities(objectId, new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()),
        optimizationActivities(objectId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      ]);
      if (growth >= Number(config.cpl_warning_pct || 30) && current.spend >= Math.max(50, baselineCpl * 3) && activities72h.length === 0) {
        const emitted = await emitAlert(config, {
          key: "no_optimization:72h",
          type: "NO_OPTIMIZATION",
          severity: "critical",
          title: "Оптимізація не зафіксована",
          cooldownHours: 24,
          details: { cplGrowth: growth, spend: current.spend, activities: 0 },
          body: `🚨 <b>NO OPTIMIZATION DETECTED</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCPL погіршився: <b>+${growth.toFixed(0)}%</b>\nSpend за 3 дні: <b>${money(current.spend)}</b>\nЗмін у кабінеті за 72 год: <b>0</b>\n\nPerformance просідає, але оптимізаційних дій не видно. Перевірте кабінет зараз.`,
        });
        summary.alerts += 1; summary.notifications += emitted.notified;
      }
      if (activities24h.length >= 12) {
        const emitted = await emitAlert(config, {
          key: "over_optimization:24h",
          type: "OVER_OPTIMIZATION",
          severity: "warning",
          title: "Ризик over-optimization",
          cooldownHours: 24,
          details: { activities: activities24h.length },
          body: `⚠️ <b>РИЗИК OVER-OPTIMIZATION</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nОптимізаційних змін за 24 год: <b>${activities24h.length}</b>\n\nЗанадто багато змін можуть не дати алгоритму стабілізувати delivery. Перевірте, чи дії системні, а не хаотичні.`,
        });
        summary.alerts += 1; summary.notifications += emitted.notified;
      }

      // 9. Creative pipeline empty — лише якщо є суттєвий spend.
      const sevenDays = await accountWindow(objectId, daysAgo(7), daysAgo(1));
      if (sevenDays.spend >= 200) {
        const metaAds = await optionalMetaGraphAll<MetaAd>(`${objectId}/ads`, { fields: "id,name,created_time,effective_status,adset_id", limit: "500" });
        const newest = metaAds.map((ad) => ad.created_time ? new Date(ad.created_time).getTime() : 0).reduce((a, b) => Math.max(a, b), 0);
        const ageDays = newest ? (Date.now() - newest) / 86400000 : 0;
        if (newest && ageDays >= 10) {
          const emitted = await emitAlert(config, {
            key: "creative_pipeline_empty:10d",
            type: "CREATIVE_PIPELINE_EMPTY",
            severity: "warning",
            title: "Потрібні нові креативи",
            cooldownHours: 48,
            details: { newestCreativeAgeDays: ageDays, spend7d: sevenDays.spend },
            body: `🧠 <b>ПОТРІБНІ НОВІ КРЕАТИВИ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nНових ads не створювали приблизно: <b>${Math.floor(ageDays)} днів</b>\nSpend за 7 днів: <b>${money(sevenDays.spend)}</b>\n\nНе дотискайте старі creatives безкінечно — потрібен новий testing pipeline.`,
          });
          summary.alerts += 1; summary.notifications += emitted.notified;
        }
      }

      // 10. Дані менеджерів / quality / funnel — тільки для PTS Reporting.
      if (config.reporting?.report_file_id) {
        const recent = await readManagerFunnel(config.reporting.report_file_id, managerDates(3, 1), config.reporting.report_start_date);
        const base = await readManagerFunnel(config.reporting.report_file_id, managerDates(7, 4), config.reporting.report_start_date);

        if (recent.totalLeads >= 10 && base.totalLeads >= 10) {
          const targetNow = recent.targetLeads / recent.totalLeads;
          const targetBase = base.targetLeads / base.totalLeads;
          const targetDrop = targetBase > 0 ? 1 - targetNow / targetBase : 0;
          if (targetDrop >= 0.3) {
            const emitted = await emitAlert(config, {
              key: "target_lead_rate_drop",
              type: "LEAD_QUALITY_DROP",
              severity: targetDrop >= 0.5 ? "critical" : "warning",
              title: "Просадка якості лідів",
              details: { targetNow, targetBase, targetDrop },
              body: `🧪 <b>ПРОСАДКА ЯКОСТІ ЛІДІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЦільові ліди: <b>${pct(targetNow)}</b> vs ${pct(targetBase)} baseline\nПросадка: <b>-${Math.round(targetDrop * 100)}%</b>`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }

          const spamNow = recent.spam / recent.totalLeads;
          const spamBase = base.spam / base.totalLeads;
          if (spamNow - spamBase >= 0.15) {
            const emitted = await emitAlert(config, {
              key: "spam_spike",
              type: "SPAM_SPIKE",
              severity: spamNow - spamBase >= 0.25 ? "critical" : "warning",
              title: "Spam spike",
              details: { spamNow, spamBase },
              body: `🗑 <b>SPAM SPIKE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nSpam зараз: <b>${pct(spamNow)}</b>\nBaseline: <b>${pct(spamBase)}</b>\n\nПеревірте аудиторії, placement-и, форму та джерело неякісного трафіку.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }

          const aNow = recent.aLeads / recent.totalLeads;
          const aBase = base.aLeads / base.totalLeads;
          const aDrop = aBase > 0 ? 1 - aNow / aBase : 0;
          if (aDrop >= 0.35) {
            const emitted = await emitAlert(config, {
              key: "a_lead_rate_drop",
              type: "A_LEAD_DROP",
              severity: aDrop >= 0.55 ? "critical" : "warning",
              title: "A-lead rate просів",
              details: { aNow, aBase, aDrop },
              body: `⭐ <b>A-LEAD RATE ПРОСІВ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nA-leads: <b>${pct(aNow)}</b> vs ${pct(aBase)} baseline\nПросадка: <b>-${Math.round(aDrop * 100)}%</b>\n\nДешевий lead не має сенсу, якщо якісних A-leads стає менше.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }

        if (recent.aLeads >= 5 && base.aLeads >= 5) {
          const meetingNow = recent.completedMeetings / recent.aLeads;
          const meetingBase = base.completedMeetings / base.aLeads;
          const drop = meetingBase > 0 ? 1 - meetingNow / meetingBase : 0;
          if (drop >= 0.35) {
            const emitted = await emitAlert(config, {
              key: "a_to_meeting_drop",
              type: "MEETING_CONVERSION_DROP",
              severity: drop >= 0.55 ? "critical" : "warning",
              title: "A-lead → meeting просів",
              details: { meetingNow, meetingBase, drop },
              body: `📞 <b>КОНВЕРСІЯ A-LEAD → MEETING ПРОСІЛА</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЗараз: <b>${pct(meetingNow)}</b>\nBaseline: <b>${pct(meetingBase)}</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\n\nПеревірте якість лідів і роботу sales — проблема вже може бути не тільки в рекламі.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }

        if (recent.completedMeetings >= 4 && base.completedMeetings >= 4) {
          const saleNow = recent.sales / recent.completedMeetings;
          const saleBase = base.sales / base.completedMeetings;
          const drop = saleBase > 0 ? 1 - saleNow / saleBase : 0;
          if (drop >= 0.4) {
            const emitted = await emitAlert(config, {
              key: "meeting_to_sale_drop",
              type: "SALE_CONVERSION_DROP",
              severity: drop >= 0.6 ? "critical" : "warning",
              title: "Meeting → sale просів",
              details: { saleNow, saleBase, drop },
              body: `💰 <b>КОНВЕРСІЯ MEETING → SALE ПРОСІЛА</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЗараз: <b>${pct(saleNow)}</b>\nBaseline: <b>${pct(saleBase)}</b>\nПросадка: <b>-${Math.round(drop * 100)}%</b>\n\nЦе вже full-funnel сигнал: перевірте не лише ads, а й sales-process / оффер / обробку.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }

        // Tracking anomaly: Meta Results vs менеджерські загальні ліди.
        if (current.results >= 10 && recent.totalLeads >= 5) {
          const diff = Math.abs(current.results - recent.totalLeads) / Math.max(current.results, recent.totalLeads);
          if (diff >= 0.3) {
            const emitted = await emitAlert(config, {
              key: "tracking_anomaly",
              type: "TRACKING_ANOMALY",
              severity: diff >= 0.5 ? "critical" : "warning",
              title: "Розбіжність Meta ↔ менеджери",
              details: { metaResults: current.results, managerLeads: recent.totalLeads, diff },
              body: `⚠️ <b>TRACKING / LEAD DELIVERY CHECK</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nMeta Results за 3 дні: <b>${current.results}</b>\nЛіди менеджерів: <b>${recent.totalLeads}</b>\nРізниця: <b>${Math.round(diff * 100)}%</b>\n\nПеревірте CRM / передачу лідів / tracking / дублікати.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }

        // Менеджери не заповнили вчорашню звітність — пушимо тільки після 11:00 Kyiv і якщо Meta реально мала results.
        if (kyivHour() >= 11) {
          const yesterdayManager = await readManagerFunnel(config.reporting.report_file_id, managerDates(1, 1), config.reporting.report_start_date);
          const yesterdayMeta = await accountWindow(objectId, daysAgo(1), daysAgo(1));
          if (yesterdayMeta.results >= 3 && yesterdayManager.totalLeads === 0) {
            const emitted = await emitAlert(config, {
              key: `manager_reporting_missing:${daysAgo(1)}`,
              type: "REPORTING_DATA_MISSING",
              severity: "warning",
              title: "Менеджери не заповнили звіт",
              cooldownHours: 24,
              details: { date: daysAgo(1), metaResults: yesterdayMeta.results },
              body: `📝 <b>ДАНІ МЕНЕДЖЕРІВ НЕ ЗАПОВНЕНІ</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nДата: <b>${daysAgo(1)}</b>\nMeta Results: <b>${yesterdayMeta.results}</b>\nЗагальні ліди менеджерів: <b>0</b>\n\nБез цих даних система не може коректно контролювати quality та full-funnel conversion.`,
            });
            summary.alerts += 1; summary.notifications += emitted.notified;
          }
        }
      }

      // Positive psychology: recovered + strong performance.
      summary.notifications += await resolveRecoveredAlerts(config, current, baseline);
      if (baselineCpl > 0 && currentCpl > 0 && current.results >= 5 && currentCpl <= baselineCpl * 0.75 && currentDailyResults >= baselineDailyResults * 0.9) {
        const emitted = await emitAlert(config, {
          key: "strong_performance",
          type: "STRONG_PERFORMANCE",
          severity: "info",
          title: "Strong performance",
          cooldownHours: 48,
          details: { currentCpl, baselineCpl, currentResults: current.results },
          body: `🏆 <b>STRONG PERFORMANCE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nCPL: <b>${money(currentCpl)}</b> vs ${money(baselineCpl)} baseline\nПокращення: <b>-${Math.round((1 - currentCpl / baselineCpl) * 100)}%</b>\nResults за 3 дні: <b>${current.results}</b>\n\nСильна динаміка — зафіксуйте, що саме спрацювало, і масштабуйте контрольовано.`,
        });
        summary.alerts += 1; summary.notifications += emitted.notified;
      }

      summary.notifications += await postOptimizationChecks(config, objectId);
    } catch (error) {
      summary.errors.push(`${config.project_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try { summary.notifications += await escalateUnacknowledged(configs); }
  catch (error) { summary.errors.push(`escalation: ${error instanceof Error ? error.message : String(error)}`); }
  return summary;
}
