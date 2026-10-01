import { listReportingConfigs, type ReportingConfig } from "@/lib/reporting-store";
import { listPerformanceMonitoringConfigs, type PerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { escapeTelegramHtml } from "@/lib/invoice-telegram";
import { getGoogleUserAccessToken } from "@/lib/google-oauth";
import { dailyBlocksForDays } from "@/lib/report-template";
import { dayIndexInPeriod, periodForDate, periodLength } from "@/lib/report-periods";
import { performanceMention, sendPerformanceMessage } from "@/lib/performance-telegram";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MANUAL_CLOSE_GRACE_MS = 6 * 60 * 60 * 1000;

type MetaAction = { action_type?: string; value?: string };
type Insight = {
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  spend?: string; clicks?: string; impressions?: string; reach?: string; frequency?: string;
  actions?: MetaAction[];
};
type CampaignMeta = { id: string; name?: string; objective?: string; effective_status?: string; status?: string };
type MetaAd = { id: string; name?: string; created_time?: string; effective_status?: string; adset_id?: string; campaign_id?: string };
type MetaActivity = { event_time?: string; event_type?: string; object_name?: string; actor_name?: string; extra_data?: string };
type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };
type AlertRecord = {
  id: number; meta_account_id: string; alert_key: string; alert_type: string; severity: string; title: string;
  details: Record<string, unknown>; first_seen_at: string; last_seen_at: string; last_notified_at: string | null;
  acknowledged_at: string | null; acknowledged_by: string | null; resolved_at: string | null; escalated_at: string | null;
};
type ManagerFunnel = { totalLeads: number; targetLeads: number; spam: number; aLeads: number; meetings: number; completedMeetings: number; sales: number };
type EffectiveConfig = PerformanceMonitoringConfig & { reporting: ReportingConfig | null };
type WindowMetric = { spend: number; results: number; clicks: number };
type CampaignPerformance = {
  id: string; name: string; objective: string; status: string; actionType: string | null;
  today: WindowMetric; yesterday: WindowMetric; recent3: WindowMetric; baseline7: WindowMetric;
};

const ACTION_FAMILIES = {
  lead: ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead", "onsite_conversion.contact_website", "offsite_conversion.fb_pixel_contact", "contact"],
  message: ["onsite_conversion.messaging_conversation_started_7d", "messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply"],
  sale: ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.purchase"],
  traffic: ["link_click", "landing_page_view"],
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
async function optionalMetaGraphAll<T>(path: string, params: Record<string, string>) { try { return await metaGraphAll<T>(path, params); } catch (error) { console.warn("Optional Meta endpoint unavailable", path, error); return [] as T[]; } }

function dateIso(date: Date) { return date.toISOString().slice(0, 10); }
function daysAgo(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return dateIso(d); }
function money(value: number) { return `$${value.toFixed(2)}`; }
function pct(value: number) { return `${Math.round(value * 100)}%`; }
function quoteSheet(title: string) { return `'${title.replace(/'/g, "''")}'`; }
function actionMap(actions?: MetaAction[]) { return new Map((actions || []).map((item) => [item.action_type || "", Number(item.value || 0)])); }
function resultFor(actions: MetaAction[] | undefined, actionType: string | null) { return actionType ? Number(actionMap(actions).get(actionType) || 0) : 0; }
function median(values: number[]) { if (!values.length) return 0; const sorted = [...values].sort((a,b)=>a-b); const m=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[m] : (sorted[m-1]+sorted[m])/2; }

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
  return metaGraphAll<Insight>(`${objectId}/insights`, { level: "campaign", fields: "campaign_id,campaign_name,spend,clicks,actions", time_range: JSON.stringify({ since, until }), limit: "500" });
}
async function buildCampaignPerformance(config: EffectiveConfig, objectId: string) {
  const [meta, todayRows, yesterdayRows, recent3Rows, baselineRows] = await Promise.all([
    metaGraphAll<CampaignMeta>(`${objectId}/campaigns`, { fields: "id,name,objective,effective_status,status", limit: "500" }),
    campaignInsights(objectId, daysAgo(0), daysAgo(0)),
    campaignInsights(objectId, daysAgo(1), daysAgo(1)),
    campaignInsights(objectId, daysAgo(3), daysAgo(1)),
    campaignInsights(objectId, daysAgo(10), daysAgo(4)),
  ]);
  const today = new Map(todayRows.map((r) => [String(r.campaign_id), r]));
  const yesterday = new Map(yesterdayRows.map((r) => [String(r.campaign_id), r]));
  const recent3 = new Map(recent3Rows.map((r) => [String(r.campaign_id), r]));
  const baseline = new Map(baselineRows.map((r) => [String(r.campaign_id), r]));
  const allIds = new Set([...meta.map((m) => m.id), ...today.keys(), ...yesterday.keys(), ...recent3.keys(), ...baseline.keys()]);
  const metaMap = new Map(meta.map((m) => [m.id, m]));
  const out: CampaignPerformance[] = [];
  for (const id of allIds) {
    const m = metaMap.get(id); const t=today.get(id); const y=yesterday.get(id); const r3=recent3.get(id); const b=baseline.get(id);
    const objective = String(m?.objective || "UNKNOWN");
    const actionType = selectStableAction(config, objective, [t, y, r3, b]);
    out.push({
      id, name:m?.name||t?.campaign_name||y?.campaign_name||r3?.campaign_name||b?.campaign_name||id,
      objective, status:String(m?.effective_status||m?.status||"UNKNOWN"), actionType,
      today:{spend:Number(t?.spend||0),results:resultFor(t?.actions,actionType),clicks:Number(t?.clicks||0)},
      yesterday:{spend:Number(y?.spend||0),results:resultFor(y?.actions,actionType),clicks:Number(y?.clicks||0)},
      recent3:{spend:Number(r3?.spend||0),results:resultFor(r3?.actions,actionType),clicks:Number(r3?.clicks||0)},
      baseline7:{spend:Number(b?.spend||0),results:resultFor(b?.actions,actionType),clicks:Number(b?.clicks||0)},
    });
  }
  return out;
}

async function getAlert(metaAccountId: string, alertKey: string) { const rows=await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(metaAccountId)}&alert_key=eq.${encodeURIComponent(alertKey)}&limit=1`); return rows[0]||null; }
async function patchAlert(id: number, patch: Record<string, unknown>) { await supabaseRequest(`performance_alerts?id=eq.${id}`, { method:"PATCH", body:JSON.stringify({ ...patch, updated_at:new Date().toISOString() }) }); }
async function saveAlert(input: { metaAccountId:string; alertKey:string; alertType:string; severity:string; title:string; details:Record<string,unknown>; cooldownHours:number }) {
  const now=new Date(); const existing=await getAlert(input.metaAccountId,input.alertKey);
  if (existing?.resolved_at) { const resolvedAt=new Date(existing.resolved_at).getTime(); if (Number.isFinite(resolvedAt)&&now.getTime()-resolvedAt<MANUAL_CLOSE_GRACE_MS) return { alert:existing,notify:false,suppressedByManualClose:true }; }
  const isReopen=Boolean(existing?.resolved_at); const lastNotified=existing?.last_notified_at?new Date(existing.last_notified_at).getTime():0;
  const notify=isReopen||!lastNotified||now.getTime()-lastNotified>=input.cooldownHours*3600000;
  const rows=await supabaseRequest<AlertRecord[]>("performance_alerts?on_conflict=meta_account_id,alert_key", { method:"POST", headers:{Prefer:"resolution=merge-duplicates,return=representation"}, body:JSON.stringify({ meta_account_id:input.metaAccountId,alert_key:input.alertKey,alert_type:input.alertType,severity:input.severity,title:input.title,details:{...(existing?.details||{}),...input.details,logic_version:"campaign_v3_smooth"},last_seen_at:now.toISOString(),updated_at:now.toISOString(),resolved_at:null,...(notify?{last_notified_at:now.toISOString(),acknowledged_at:null,acknowledged_by:null,escalated_at:null}:{}) }) });
  return { alert:rows[0],notify,suppressedByManualClose:false };
}
async function emitAlert(config: EffectiveConfig, input: { key:string; type:string; severity:string; title:string; body:string; details:Record<string,unknown>; cooldownHours?:number }) {
  const saved=await saveAlert({metaAccountId:config.meta_account_id,alertKey:input.key,alertType:input.type,severity:input.severity,title:input.title,details:input.details,cooldownHours:input.cooldownHours??12});
  if (!saved.notify||saved.suppressedByManualClose) return {alert:saved.alert,notified:0};
  const tag=performanceMention(config.targetologist_telegram);
  await sendPerformanceMessage(`${input.body}${tag?`\nТаргетолог / Targetologist: ${tag}`:""}\nAlert ID: <code>${saved.alert.id}</code>${["action_required","critical"].includes(input.severity)?`\nПідтвердити / ACK: <code>/perf_ack ${saved.alert.id}</code>`:""}`);
  return {alert:saved.alert,notified:1};
}
async function resolveLegacyCampaignAlerts(config: EffectiveConfig) {
  const rows=await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&alert_type=in.(CPL_SPIKE,CAMPAIGN_CPL_SPIKE,CAMPAIGN_VOLUME_DROP)&limit=200`);
  for (const row of rows) await patchAlert(row.id,{resolved_at:new Date().toISOString(),details:{...(row.details||{}),resolved_reason:"replaced_by_campaign_v3_smoothing"}});
}

function managerDates(fromDaysAgo:number,toDaysAgo:number){const dates:Date[]=[];for(let d=fromDaysAgo;d>=toDaysAgo;d--){const date=new Date();date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-d);dates.push(date);}return dates;}
async function readManagerFunnel(spreadsheetId:string,dates:Date[],reportingStartDate:string):Promise<ManagerFunnel>{
  const eligible=dates.filter((date)=>dateIso(date)>=reportingStartDate); const zero={totalLeads:0,targetLeads:0,spam:0,aLeads:0,meetings:0,completedMeetings:0,sales:0}; if(!eligible.length)return zero;
  const ranges=eligible.map((date)=>{const period=periodForDate(date);const blocks=dailyBlocksForDays(periodLength(period));const block=blocks[dayIndexInPeriod(date,period)];const totalRow=block.dataStartRow+16;return `${quoteSheet(period.title)}!B${totalRow}:O${totalRow}`;});
  const token=await getGoogleUserAccessToken(); const url=new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`); ranges.forEach((range)=>url.searchParams.append("ranges",range));
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:"no-store"}); if(!response.ok)return zero; const body=await response.json() as {valueRanges?:Array<{values?:Array<Array<string|number>>}>}; const total={...zero};
  for(const valueRange of body.valueRanges||[]){const row=valueRange.values?.[0]||[];total.totalLeads+=Number(row[0]||0);total.targetLeads+=Number(row[5]||0);total.spam+=Number(row[6]||0);total.aLeads+=Number(row[8]||0);total.meetings+=Number(row[10]||0);total.completedMeetings+=Number(row[11]||0);total.sales+=Number(row[13]||0);} return total;
}
async function optimizationActivities(objectId:string){return optionalMetaGraphAll<MetaActivity>(`${objectId}/activities`,{fields:"event_time,event_type,object_name,actor_name,extra_data",since:new Date(Date.now()-72*3600000).toISOString(),limit:"200"});}

function hasTodayRecovery(c: CampaignPerformance) {
  const baselineDailyResults=c.baseline7.results/7;
  const baselineCpl=c.baseline7.results>0?c.baseline7.spend/c.baseline7.results:0;
  const todayCpl=c.today.results>0?c.today.spend/c.today.results:0;
  const volumeRecovered=c.today.results>=Math.max(2,baselineDailyResults*0.8);
  const cplHealthy=!baselineCpl||!todayCpl||todayCpl<=baselineCpl*1.35;
  return volumeRecovered&&cplHealthy;
}

async function resolveRecoveredCampaignAlerts(config:EffectiveConfig,campaigns:CampaignPerformance[]){
  const rows=await supabaseRequest<AlertRecord[]>(`performance_alerts?select=*&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&alert_type=in.(CAMPAIGN_CPL_ROLLING,CAMPAIGN_VOLUME_ROLLING,CAMPAIGN_SPEND_WITHOUT_RESULTS)&limit=100`); let notifications=0;
  for(const alert of rows){const campaignId=String(alert.details?.campaignId||"");const c=campaigns.find((item)=>item.id===campaignId);if(!c)continue;const baselineCpl=c.baseline7.results>0?c.baseline7.spend/c.baseline7.results:0;const recentCpl=c.recent3.results>0?c.recent3.spend/c.recent3.results:0;const baseDaily=c.baseline7.results/7;const recentDaily=c.recent3.results/3;let recovered=false;
    if(alert.alert_type==="CAMPAIGN_CPL_ROLLING"&&recentCpl>0&&baselineCpl>0&&recentCpl<=baselineCpl*1.15)recovered=true;
    if(alert.alert_type==="CAMPAIGN_VOLUME_ROLLING"&&baseDaily>0&&recentDaily>=baseDaily*0.9)recovered=true;
    if(alert.alert_type==="CAMPAIGN_SPEND_WITHOUT_RESULTS"&&c.today.results>0)recovered=true;
    if(hasTodayRecovery(c))recovered=true;
    if(!recovered)continue; await patchAlert(alert.id,{resolved_at:new Date().toISOString()}); await sendPerformanceMessage(`🟢 <b>ВІДНОВЛЕННЯ / RECOVERED</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(c.name)}</b>\nСьогоднішня динаміка вже повернулась у нормальний діапазон.`); notifications++;
  } return notifications;
}

export async function runPerformanceMonitor(){
  const [monitoringRows,reportingRows]=await Promise.all([listPerformanceMonitoringConfigs(),listReportingConfigs()]); const reportingMap=new Map(reportingRows.map((item)=>[item.meta_account_id,item])); const configs:EffectiveConfig[]=monitoringRows.filter((item)=>item.enabled).map((item)=>({...item,reporting:reportingMap.get(item.meta_account_id)||null})); const summary={projects:configs.length,alerts:0,notifications:0,errors:[] as string[]};
  for(const config of configs){
    try{
      const objectId=config.meta_account_id.startsWith("act_")?config.meta_account_id:`act_${config.meta_account_id}`; await resolveLegacyCampaignAlerts(config); const campaigns=await buildCampaignPerformance(config,objectId); const active=campaigns.filter((c)=>c.status==="ACTIVE"||c.today.spend>0||c.yesterday.spend>0||c.recent3.spend>0);
      for(const c of active){
        if(!c.actionType)continue; const baselineCpl=c.baseline7.results>0?c.baseline7.spend/c.baseline7.results:0; const recentCpl=c.recent3.results>0?c.recent3.spend/c.recent3.results:0; const baselineDailyResults=c.baseline7.results/7; const recentDailyResults=c.recent3.results/3; const baselineDailySpend=c.baseline7.spend/7; const recentDailySpend=c.recent3.spend/3; const todayRecovery=hasTodayRecovery(c);

        // Sustained CPL deterioration only: rolling 3 completed days vs previous 7 completed days.
        if(!todayRecovery&&baselineCpl>0&&c.recent3.results>=5&&c.recent3.spend>=Math.max(25,baselineCpl*5)){
          const growth=(recentCpl/baselineCpl-1)*100;
          if(growth>=Number(config.cpl_warning_pct||25)){
            const critical=growth>=Math.max(Number(config.cpl_critical_pct||40),55)&&c.recent3.results>=7;
            const emitted=await emitAlert(config,{key:`campaign_cpl_rolling3:${c.id}`,type:"CAMPAIGN_CPL_ROLLING",severity:critical?"critical":"warning",title:`CPL ${critical?"critical":"watch"} — ${c.name}`,details:{campaignId:c.id,campaignName:c.name,objective:c.objective,actionType:c.actionType,recentCpl,baselineCpl,growth,recent3:c.recent3,baseline7:c.baseline7,today:c.today,todayRecovery},body:`${critical?"🔴":"🟠"} <b>${critical?"СТІЙКЕ ПОГІРШЕННЯ CPL / CPL CRITICAL":"CPL ПІД СПОСТЕРЕЖЕННЯМ / CPL WATCH"}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(c.name)}</b>\nResult action: <code>${escapeTelegramHtml(c.actionType)}</code>\nОстанні 3 повні дні / Last 3d: <b>${c.recent3.results} results · ${money(recentCpl)}</b>\nПопередні 7 днів / Previous 7d: <b>${c.baseline7.results} results · ${money(baselineCpl)}</b>\nЗміна CPL / Change: <b>+${growth.toFixed(0)}%</b>`}); summary.alerts++; summary.notifications+=emitted.notified;
          }
        }

        // Sustained volume drop. One bad day alone never creates a task.
        if(!todayRecovery&&baselineDailyResults>=1&&recentDailySpend>=baselineDailySpend*0.8){
          const drop=1-recentDailyResults/baselineDailyResults;
          if(drop>=0.45&&c.recent3.results>=2){
            const critical=drop>=0.7&&c.recent3.spend>=Math.max(30,baselineDailySpend*2.4);
            const emitted=await emitAlert(config,{key:`campaign_volume_rolling3:${c.id}`,type:"CAMPAIGN_VOLUME_ROLLING",severity:critical?"critical":"warning",title:`Просадка results / Results drop — ${c.name}`,details:{campaignId:c.id,campaignName:c.name,actionType:c.actionType,recent3:c.recent3,baseline7:c.baseline7,drop,today:c.today,todayRecovery},body:`📉 <b>${critical?"СТІЙКА ПРОСАДКА / RESULTS DROP CRITICAL":"СПОСТЕРЕЖЕННЯ / RESULTS WATCH"}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(c.name)}</b>\nОстанні 3 дні avg/day: <b>${recentDailyResults.toFixed(1)}</b>\nПопередні 7 днів avg/day: <b>${baselineDailyResults.toFixed(1)}</b>\nПросадка / Drop: <b>-${Math.round(drop*100)}%</b>\nСьогодні / Today: <b>${c.today.results} results</b>`}); summary.alerts++; summary.notifications+=emitted.notified;
          }
        }

        // Intraday emergency only. A partial day can suppress alerts, but cannot create CPL/volume conclusions.
        const emergencySpend=Math.max(20,baselineCpl>0?baselineCpl*3:30);
        if(c.today.results===0&&c.today.spend>=emergencySpend&&(c.status==="ACTIVE"||c.today.spend>0)){
          const emitted=await emitAlert(config,{key:`campaign_spend_without_results:${c.id}`,type:"CAMPAIGN_SPEND_WITHOUT_RESULTS",severity:"critical",title:`Spend без results — ${c.name}`,cooldownHours:6,details:{campaignId:c.id,campaignName:c.name,objective:c.objective,actionType:c.actionType,today:c.today,baselineCpl,notifiedSpend:c.today.spend},body:`🚨 <b>SPEND БЕЗ РЕЗУЛЬТАТІВ / SPEND WITHOUT RESULTS</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(c.name)}</b>\nСьогодні spend: <b>${money(c.today.spend)}</b>\nResults: <b>0</b>${baselineCpl>0?`\nBaseline CPL: <b>${money(baselineCpl)}</b>`:""}`}); summary.alerts++; summary.notifications+=emitted.notified;
        }
      }

      // Creative + ad set efficiency: same campaign result action.
      const actionByCampaign=new Map(active.map((c)=>[c.id,c.actionType]));
      const [ads,adsets]=await Promise.all([
        metaGraphAll<Insight>(`${objectId}/insights`,{level:"ad",fields:"campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,actions,frequency",time_range:JSON.stringify({since:daysAgo(2),until:daysAgo(0)}),limit:"500"}),
        metaGraphAll<Insight>(`${objectId}/insights`,{level:"adset",fields:"campaign_id,campaign_name,adset_id,adset_name,spend,actions",time_range:JSON.stringify({since:daysAgo(2),until:daysAgo(0)}),limit:"500"}),
      ]);
      const adsByAdset=new Map<string,Insight[]>(); for(const row of ads){const key=row.adset_id||row.adset_name||"unknown";const bucket=adsByAdset.get(key)||[];bucket.push(row);adsByAdset.set(key,bucket);}
      for(const [adsetId,rows] of adsByAdset){const campaignId=String(rows[0]?.campaign_id||"");const actionType=actionByCampaign.get(campaignId)||null;if(!actionType)continue;const productive=rows.filter((r)=>resultFor(r.actions,actionType)>0);if(productive.length<2)continue;const peerMedian=median(productive.map((r)=>Number(r.spend||0)/resultFor(r.actions,actionType)).filter((v)=>v>0));const adsetSpend=rows.reduce((s,r)=>s+Number(r.spend||0),0);
        for(const row of rows){const spend=Number(row.spend||0);const res=resultFor(row.actions,actionType);const cpl=res>0?spend/res:Infinity;const name=row.ad_name||"Без назви";const threshold=Math.max(Number(config.creative_waste_min_spend||15),peerMedian*Number(config.creative_waste_cpl_multiplier||1.5));
          if(res===0&&spend>=threshold){const emitted=await emitAlert(config,{key:`creative_waste:${adsetId}:${row.ad_id||name}`,type:"CREATIVE_WASTE",severity:spend>=threshold*1.5?"critical":"action_required",title:"Креатив потребує оптимізації / Creative waste",details:{campaignId,adsetId,adId:row.ad_id,adName:name,actionType,spend,results:res,peerMedianCpl:peerMedian,threshold,notifiedSpend:spend},body:`⚡ <b>КРЕАТИВ ПОТРЕБУЄ ОПТИМІЗАЦІЇ / CREATIVE WASTE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(row.campaign_name||"—")}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name||"—")}</b>\nКреатив / Creative: <b>${escapeTelegramHtml(name)}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>0</b>`});summary.alerts++;summary.notifications+=emitted.notified;}
          if(res>=5&&peerMedian>0&&cpl<=peerMedian*0.6){const share=adsetSpend>0?spend/adsetSpend:0;const emitted=await emitAlert(config,{key:`creative_winner:${adsetId}:${row.ad_id||name}`,type:"CREATIVE_WINNER",severity:"info",title:"Сильний креатив / Creative winner",cooldownHours:36,details:{campaignId,adName:name,actionType,spend,results:res,cpl,peerMedianCpl:peerMedian,share},body:`🏆 <b>СИЛЬНИЙ КРЕАТИВ / CREATIVE WINNER</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(row.campaign_name||"—")}</b>\nКреатив / Creative: <b>${escapeTelegramHtml(name)}</b>\nResults: <b>${res}</b> · CPL: <b>${money(cpl)}</b>\nPeer median: <b>${money(peerMedian)}</b>`});summary.alerts++;summary.notifications+=emitted.notified;}
          const frequency=Number(row.frequency||0);if(res>=2&&frequency>=3.5&&peerMedian>0&&cpl>=peerMedian*1.4){const emitted=await emitAlert(config,{key:`creative_fatigue:${row.ad_id||name}`,type:"CREATIVE_FATIGUE",severity:"warning",title:"Креатив вигорає / Creative fatigue",cooldownHours:24,details:{campaignId,adName:name,actionType,frequency,cpl,peerMedianCpl:peerMedian,results:res},body:`🎨 <b>КРЕАТИВ ВИГОРЯЄ / CREATIVE FATIGUE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(row.campaign_name||"—")}</b>\nКреатив / Creative: <b>${escapeTelegramHtml(name)}</b>\nFrequency: <b>${frequency.toFixed(1)}</b>\nCPL: <b>${money(cpl)}</b> vs peer ${money(peerMedian)}`});summary.alerts++;summary.notifications+=emitted.notified;}
        }
      }
      const adsetsByCampaign=new Map<string,Insight[]>();for(const row of adsets){const key=String(row.campaign_id||"unknown");const bucket=adsetsByCampaign.get(key)||[];bucket.push(row);adsetsByCampaign.set(key,bucket);}for(const [campaignId,rows] of adsetsByCampaign){const actionType=actionByCampaign.get(campaignId)||null;if(!actionType)continue;const productive=rows.filter((r)=>resultFor(r.actions,actionType)>0);if(productive.length<2)continue;const med=median(productive.map((r)=>Number(r.spend||0)/resultFor(r.actions,actionType)).filter((v)=>v>0));for(const row of rows){const spend=Number(row.spend||0);const res=resultFor(row.actions,actionType);const cpl=res>0?spend/res:Infinity;if(spend>=Math.max(30,med*3)&&((res===0&&spend>=med*2)||cpl>=med*1.8)){const emitted=await emitAlert(config,{key:`adset_waste:${campaignId}:${row.adset_id||row.adset_name}`,type:"ADSET_WASTE",severity:cpl>=med*2.5||res===0?"critical":"action_required",title:"Ad set потребує оптимізації",details:{campaignId,adsetName:row.adset_name,actionType,spend,results:res,cpl:Number.isFinite(cpl)?cpl:0,peerMedianCpl:med},body:`⚡ <b>AD SET ПОТРЕБУЄ ОПТИМІЗАЦІЇ / AD SET WASTE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампанія / Campaign: <b>${escapeTelegramHtml(row.campaign_name||"—")}</b>\nAd set: <b>${escapeTelegramHtml(row.adset_name||"—")}</b>\nSpend: <b>${money(spend)}</b> · Results: <b>${res}</b>${Number.isFinite(cpl)?`\nCPL: <b>${money(cpl)}</b>`:""}`});summary.alerts++;summary.notifications+=emitted.notified;}}}

      const badCampaigns=active.filter((c)=>{if(hasTodayRecovery(c))return false;const rc=c.recent3.results>0?c.recent3.spend/c.recent3.results:0;const bc=c.baseline7.results>0?c.baseline7.spend/c.baseline7.results:0;return bc>0&&rc>bc*1.5&&c.recent3.results>=5&&c.recent3.spend>=Math.max(30,bc*5);});
      if(badCampaigns.length){const activities=await optimizationActivities(objectId);const relevant=activities.filter((row)=>/(campaign|adset|ad_set|ad_|budget|bid|status|target|creative|update|create|pause)/.test(String(row.event_type||"").toLowerCase()));if(!relevant.length){const emitted=await emitAlert(config,{key:"no_optimization:72h:v3",type:"NO_OPTIMIZATION",severity:"critical",title:"Оптимізація не зафіксована / No optimization",cooldownHours:24,details:{badCampaigns:badCampaigns.map((c)=>({id:c.id,name:c.name})),activities:0},body:`🚨 <b>НЕМАЄ ОПТИМІЗАЦІЇ / NO OPTIMIZATION</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКампаній зі стійким погіршенням: <b>${badCampaigns.length}</b>\nЗмін у кабінеті за 72 год: <b>0</b>`});summary.alerts++;summary.notifications+=emitted.notified;}}

      const total7dSpend=active.reduce((s,c)=>s+c.baseline7.spend,0);if(total7dSpend>=200){const metaAds=await optionalMetaGraphAll<MetaAd>(`${objectId}/ads`,{fields:"id,name,created_time,effective_status,adset_id,campaign_id",limit:"500"});const newest=metaAds.map((ad)=>ad.created_time?new Date(ad.created_time).getTime():0).reduce((a,b)=>Math.max(a,b),0);const ageDays=newest?(Date.now()-newest)/86400000:0;if(newest&&ageDays>=10){const emitted=await emitAlert(config,{key:"creative_pipeline_empty:10d:v3",type:"CREATIVE_PIPELINE_EMPTY",severity:"warning",title:"Потрібні нові креативи / Creative pipeline",cooldownHours:48,details:{newestCreativeAgeDays:ageDays,spend7d:total7dSpend},body:`🧠 <b>ПОТРІБНІ НОВІ КРЕАТИВИ / CREATIVE PIPELINE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nНових ads не створювали: <b>~${Math.floor(ageDays)} днів</b>\n7d spend: <b>${money(total7dSpend)}</b>`});summary.alerts++;summary.notifications+=emitted.notified;}}

      if(config.reporting?.report_file_id&&config.reporting.report_file_id!=="MONITOR_ONLY"){
        const recent=await readManagerFunnel(config.reporting.report_file_id,managerDates(3,1),config.reporting.report_start_date);const base=await readManagerFunnel(config.reporting.report_file_id,managerDates(7,4),config.reporting.report_start_date);
        if(recent.totalLeads>=10&&base.totalLeads>=10){const targetNow=recent.targetLeads/recent.totalLeads;const targetBase=base.targetLeads/base.totalLeads;const targetDrop=targetBase>0?1-targetNow/targetBase:0;if(targetDrop>=0.3){const emitted=await emitAlert(config,{key:"target_lead_rate_drop:v3",type:"LEAD_QUALITY_DROP",severity:targetDrop>=0.5?"critical":"warning",title:"Просадка якості лідів / Lead quality drop",details:{targetNow,targetBase,targetDrop},body:`🧪 <b>ПРОСАДКА ЯКОСТІ ЛІДІВ / LEAD QUALITY DROP</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЦільові ліди: <b>${pct(targetNow)}</b> vs ${pct(targetBase)} baseline`});summary.alerts++;summary.notifications+=emitted.notified;}const spamNow=recent.spam/recent.totalLeads;const spamBase=base.spam/base.totalLeads;if(spamNow-spamBase>=0.15){const emitted=await emitAlert(config,{key:"spam_spike:v3",type:"SPAM_SPIKE",severity:spamNow-spamBase>=0.25?"critical":"warning",title:"Стрибок спаму / Spam spike",details:{spamNow,spamBase},body:`🗑 <b>СТРИБОК СПАМУ / SPAM SPIKE</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nSpam зараз: <b>${pct(spamNow)}</b>\nBaseline: <b>${pct(spamBase)}</b>`});summary.alerts++;summary.notifications+=emitted.notified;}}
        if(recent.aLeads>=5&&base.aLeads>=5){const now=recent.completedMeetings/recent.aLeads;const prev=base.completedMeetings/base.aLeads;const drop=prev>0?1-now/prev:0;if(drop>=0.35){const emitted=await emitAlert(config,{key:"a_to_meeting_drop:v3",type:"MEETING_CONVERSION_DROP",severity:drop>=0.55?"critical":"warning",title:"A-lead → meeting просів",details:{meetingNow:now,meetingBase:prev,drop},body:`📞 <b>A-LEAD → MEETING ПРОСІВ / CONVERSION DROP</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЗараз: <b>${pct(now)}</b>\nBaseline: <b>${pct(prev)}</b>`});summary.alerts++;summary.notifications+=emitted.notified;}}
        if(recent.completedMeetings>=4&&base.completedMeetings>=4){const now=recent.sales/recent.completedMeetings;const prev=base.sales/base.completedMeetings;const drop=prev>0?1-now/prev:0;if(drop>=0.35){const emitted=await emitAlert(config,{key:"meeting_to_sale_drop:v3",type:"SALE_CONVERSION_DROP",severity:drop>=0.55?"critical":"warning",title:"Meeting → sale просів",details:{saleNow:now,saleBase:prev,drop},body:`💰 <b>MEETING → SALE ПРОСІВ / CONVERSION DROP</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nЗараз: <b>${pct(now)}</b>\nBaseline: <b>${pct(prev)}</b>`});summary.alerts++;summary.notifications+=emitted.notified;}}
      }

      summary.notifications+=await resolveRecoveredCampaignAlerts(config,campaigns);
    }catch(error){summary.errors.push(`${config.project_name}: ${error instanceof Error?error.message:String(error)}`);}
  }
  return summary;
}
