import { getReportingConfig } from "@/lib/reporting-store";
import { getPerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

type MetaAction = { action_type?: string; value?: string };
type Insight = { spend?: string; clicks?: string; impressions?: string; actions?: MetaAction[] };
type Campaign = { id: string; name?: string; status?: string; effective_status?: string; objective?: string };
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };
type AlertRow = { id: number; alert_type: string; severity: string; title: string; details?: Record<string, unknown>; first_seen_at: string; last_seen_at: string; acknowledged_at: string | null; resolved_at: string | null };

type WindowData = {
  label: string;
  since: string;
  until: string;
  spend: number;
  clicks: number;
  impressions: number;
  selectedAction: string | null;
  selectedResults: number;
  cpl: number | null;
  actions: Array<{ type: string; value: number }>;
};

function normalizeAccountId(value: string) {
  const id = value.trim().replace(/^act_/i, "");
  return `act_${id}`;
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

function iso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return iso(d); }
function money(v: number) { return `$${v.toFixed(2)}`; }

function actionMap(actions: MetaAction[] = []) {
  const map = new Map<string, number>();
  for (const action of actions) {
    const key = String(action.action_type || "");
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + Number(action.value || 0));
  }
  return map;
}

function pickSelectedAction(map: Map<string, number>) {
  for (const type of RESULT_ACTION_PRIORITY) {
    if (map.has(type)) return { type, value: Number(map.get(type) || 0) };
  }
  return { type: null, value: 0 };
}

async function windowData(objectId: string, label: string, since: string, until: string): Promise<WindowData> {
  const rows = await metaGraphAll<Insight>(`${objectId}/insights`, {
    level: "account",
    fields: "spend,clicks,impressions,actions",
    time_range: JSON.stringify({ since, until }),
    limit: "50",
  });
  const spend = rows.reduce((s, r) => s + Number(r.spend || 0), 0);
  const clicks = rows.reduce((s, r) => s + Number(r.clicks || 0), 0);
  const impressions = rows.reduce((s, r) => s + Number(r.impressions || 0), 0);
  const map = new Map<string, number>();
  for (const row of rows) for (const [key, value] of actionMap(row.actions)) map.set(key, (map.get(key) || 0) + value);
  const selected = pickSelectedAction(map);
  const actions = [...map.entries()]
    .map(([type, value]) => ({ type, value }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  return {
    label, since, until, spend, clicks, impressions,
    selectedAction: selected.type,
    selectedResults: selected.value,
    cpl: selected.value > 0 ? spend / selected.value : null,
    actions,
  };
}

function quoteSheet(title: string) { return `'${title.replace(/'/g, "''")}'`; }

async function readManagerDay(spreadsheetId: string, dateIso: string, reportingStartDate: string) {
  const zero = { totalLeads: 0, targetLeads: 0, spam: 0, aLeads: 0, meetings: 0, completedMeetings: 0, sales: 0 };
  if (!spreadsheetId || spreadsheetId === "MONITOR_ONLY" || dateIso < reportingStartDate) return zero;
  const date = new Date(`${dateIso}T00:00:00Z`);
  const period = periodForDate(date);
  const blocks = dailyBlocksForDays(periodLength(period));
  const block = blocks[dayIndexInPeriod(date, period)];
  if (!block) return zero;
  const totalRow = block.dataStartRow + 16;
  const range = `${quoteSheet(period.title)}!B${totalRow}:O${totalRow}`;
  const token = await getGoogleUserAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) return zero;
  const body = await response.json() as { values?: Array<Array<string | number>> };
  const row = body.values?.[0] || [];
  return {
    totalLeads: Number(row[0] || 0), targetLeads: Number(row[5] || 0), spam: Number(row[6] || 0),
    aLeads: Number(row[8] || 0), meetings: Number(row[10] || 0), completedMeetings: Number(row[11] || 0), sales: Number(row[13] || 0),
  };
}

async function openAlerts(accountId: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [] as AlertRow[];
  const response = await fetch(`${url}/rest/v1/performance_alerts?select=id,alert_type,severity,title,details,first_seen_at,last_seen_at,acknowledged_at,resolved_at&meta_account_id=eq.${encodeURIComponent(accountId)}&resolved_at=is.null&order=last_seen_at.desc&limit=20`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store",
  });
  if (!response.ok) return [] as AlertRow[];
  return await response.json() as AlertRow[];
}

function windowLine(w: WindowData) {
  return `• <b>${escapeTelegramHtml(w.label)}</b> (${w.since} → ${w.until})\nSpend: <b>${money(w.spend)}</b> · Bot results: <b>${w.selectedResults}</b>${w.cpl !== null ? ` · CPL: <b>${money(w.cpl)}</b>` : ""}\nAction: <code>${escapeTelegramHtml(w.selectedAction || "none")}</code>`;
}

export async function auditPerformanceAccount(rawAccountId: string) {
  const accountId = normalizeAccountId(rawAccountId);
  const [monitoring, reporting] = await Promise.all([
    getPerformanceMonitoringConfig(accountId),
    getReportingConfig(accountId),
  ]);
  if (!monitoring && !reporting) throw new Error(`Account ${accountId} is not configured in Performance/Reporting`);

  const projectName = monitoring?.project_name || reporting?.project_name || accountId;
  const objectId = accountId;
  const [today, yesterday, current3d, baseline7d, campaigns, alerts] = await Promise.all([
    windowData(objectId, "Сьогодні (до зараз)", daysAgo(0), daysAgo(0)),
    windowData(objectId, "Вчора", daysAgo(1), daysAgo(1)),
    windowData(objectId, "Поточне 3d-вікно бота", daysAgo(3), daysAgo(1)),
    windowData(objectId, "Baseline 7d бота", daysAgo(10), daysAgo(4)),
    metaGraphAll<Campaign>(`${objectId}/campaigns`, { fields: "id,name,status,effective_status,objective", limit: "200" }),
    openAlerts(accountId),
  ]);

  let manager = null as null | Awaited<ReturnType<typeof readManagerDay>>;
  if (reporting?.report_file_id && reporting.report_file_id !== "MONITOR_ONLY") {
    manager = await readManagerDay(reporting.report_file_id, daysAgo(1), reporting.report_start_date);
  }

  const currentCpl = current3d.cpl || 0;
  const baselineCpl = baseline7d.cpl || 0;
  const growth = baselineCpl > 0 && currentCpl > 0 ? ((currentCpl / baselineCpl) - 1) * 100 : 0;
  const warn = Number(monitoring?.cpl_warning_pct ?? reporting?.cpl_warning_pct ?? 25);
  const critical = Number(monitoring?.cpl_critical_pct ?? reporting?.cpl_critical_pct ?? 40);
  const cplWouldTrigger = baselineCpl > 0 && current3d.selectedResults >= 3 && current3d.spend >= baselineCpl * 3 && growth >= warn;

  const activeCampaigns = campaigns.filter((c) => ["ACTIVE", "PAUSED"].includes(String(c.effective_status || c.status || "")));
  const topActions = yesterday.actions.slice(0, 10).map((a) => `• <code>${escapeTelegramHtml(a.type)}</code> = <b>${a.value}</b>`).join("\n") || "• немає actions";
  const activeCampaignLines = activeCampaigns.slice(0, 12).map((c) => `• ${c.effective_status === "ACTIVE" ? "🟢" : "⚪️"} <b>${escapeTelegramHtml(c.name || c.id)}</b> · <code>${escapeTelegramHtml(c.objective || "—")}</code>`).join("\n") || "• кампаній не знайдено";

  const msg1 = `🧪 <b>PTS ACCOUNT AUDIT</b>\n\nПроєкт: <b>${escapeTelegramHtml(projectName)}</b>\nКабінет: <code>${escapeTelegramHtml(accountId)}</code>\nPerformance: <b>${monitoring?.enabled ? "ON" : "OFF"}</b>\nReporting: <b>${reporting ? "ON" : "OFF"}</b>${reporting ? `\nConfigured goal: <b>${escapeTelegramHtml(reporting.goal_label)}</b> · <code>${escapeTelegramHtml(reporting.goal_key)}</code>` : ""}\n\n<b>ЩО БАЧИТЬ БОТ ПО META</b>\n${windowLine(today)}\n\n${windowLine(yesterday)}\n\n${windowLine(current3d)}\n\n${windowLine(baseline7d)}`;

  const msg2 = `🔎 <b>WHY / RAW ACTIONS</b>\n\n<b>Actions за вчора:</b>\n${topActions}\n\n<b>Поточна логіка CPL alert:</b>\nCurrent 3d CPL: <b>${money(currentCpl)}</b>\nBaseline 7d CPL: <b>${money(baselineCpl)}</b>\nЗміна: <b>${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%</b>\nThresholds: warning <b>+${warn}%</b> · critical <b>+${critical}%</b>\nРезультат rule: <b>${cplWouldTrigger ? (growth >= critical ? "🔴 CRITICAL" : "🟠 WARNING") : "🟢 НЕ МАЄ СПРАЦЬОВУВАТИ"}</b>\n\n⚠️ Bot result зараз = перший action із hardcoded priority list, а не гарантовано configured goal. Саме тут може бути mismatch з Ads Manager.`;

  const reportingBlock = manager
    ? `<b>Google Sheet за вчора:</b>\nTotal leads: <b>${manager.totalLeads}</b> · Target: <b>${manager.targetLeads}</b> · Spam: <b>${manager.spam}</b>\nA-leads: <b>${manager.aLeads}</b> · Meetings: <b>${manager.completedMeetings}</b> · Sales: <b>${manager.sales}</b>`
    : `<b>Google Sheet:</b> немає підключеного reporting або дані недоступні.`;
  const alertLines = alerts.length ? alerts.map((a) => `• #${a.id} · <b>${escapeTelegramHtml(a.title)}</b> · ${escapeTelegramHtml(a.severity)} · ${a.acknowledged_at ? "ACK" : "waiting"}`).join("\n") : "• відкритих alerts немає";
  const msg3 = `📊 <b>REPORTING + ACCOUNT STATE</b>\n\n${reportingBlock}\n\n<b>Campaigns:</b>\n${activeCampaignLines}\n\n<b>Open alerts:</b>\n${alertLines}`;

  return { accountId, projectName, messages: [msg1, msg2, msg3] };
}
