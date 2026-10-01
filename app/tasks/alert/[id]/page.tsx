import Link from "next/link";
import { notFound } from "next/navigation";
import { getPerformanceAlertById } from "@/lib/performance-dashboard";

export const dynamic = "force-dynamic";

type Metric = { spend?: number; results?: number; clicks?: number; impressions?: number };
type Diagnosis = { cplChange?: number; cpmChange?: number; ctrChange?: number; crChange?: number; reason?: string; confidence?: string };

function fmt(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("uk-UA") : "—";
}

function duration(from: string, to?: string | null) {
  if (!to) return "—";
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  if (minutes < 60) return `${minutes} хв`;
  return `${(minutes / 60).toFixed(1)} год`;
}

function valueText(value: unknown) {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metric(value: unknown): Metric {
  const row = obj(value);
  return {
    spend: Number(row.spend || 0),
    results: Number(row.results || 0),
    clicks: Number(row.clicks || 0),
    impressions: Number(row.impressions || 0),
  };
}

function diagnosis(value: unknown): Diagnosis {
  const row = obj(value);
  return {
    cplChange: typeof row.cplChange === "number" ? row.cplChange : Number(row.cplChange || 0),
    cpmChange: typeof row.cpmChange === "number" ? row.cpmChange : Number(row.cpmChange || 0),
    ctrChange: typeof row.ctrChange === "number" ? row.ctrChange : Number(row.ctrChange || 0),
    crChange: typeof row.crChange === "number" ? row.crChange : Number(row.crChange || 0),
    reason: typeof row.reason === "string" ? row.reason : undefined,
    confidence: typeof row.confidence === "string" ? row.confidence : undefined,
  };
}

function money(value: number | undefined) { return `$${Number(value || 0).toFixed(2)}`; }
function pct(value: number | undefined) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${Math.round(number * 100)}%`;
}
function cpl(row: Metric) { return Number(row.results || 0) > 0 ? Number(row.spend || 0) / Number(row.results || 0) : 0; }
function cpm(row: Metric) { return Number(row.impressions || 0) > 0 ? Number(row.spend || 0) / Number(row.impressions || 0) * 1000 : 0; }
function ctr(row: Metric) { return Number(row.impressions || 0) > 0 ? Number(row.clicks || 0) / Number(row.impressions || 0) : 0; }
function cr(row: Metric) { return Number(row.clicks || 0) > 0 ? Number(row.results || 0) / Number(row.clicks || 0) : 0; }
function ratio(now: number, base: number) { return base > 0 ? now / base - 1 : 0; }

function nextAction(alertType: string, reason?: string) {
  const type = alertType.toUpperCase();
  const why = (reason || "").toLowerCase();
  if (type.includes("SPEND_WITHOUT_RESULTS")) return "Перевірити delivery, правильність result action, форму/лендінг і чи немає технічної проблеми з конверсіями. Не чекати завершення дня.";
  if (type.includes("CREATIVE_WASTE")) return "Перевірити конкретний creative: spend уже перевищив допустимий поріг без результату. Порівняти з іншими ads у цій кампанії та вирішити, чи вимикати/замінювати.";
  if (type.includes("CREATIVE_FATIGUE")) return "Перевірити frequency, CTR, CPM і CPL цього creative. Якщо комбінація сигналів підтверджується — оновити hook/visual/copy або ротацію.";
  if (type.includes("ADSET")) return "Перевірити саме цей ad set: spend, results, audience overlap та чи є сенс далі давати йому бюджет. Не порівнювати лише по рівному spend при CBO.";
  if (why.includes("креатив") || why.includes("creative")) return "Почати з creative layer: CTR, hooks, visual/copy та fatigue. Не змінювати landing без підтвердження просадки post-click CR.";
  if (why.includes("ленд") || why.includes("форма") || why.includes("tracking")) return "Перевірити post-click шлях: landing/form, швидкість, трекінг, коректність event та якість трафіку. Creative може бути не головною причиною.";
  if (why.includes("аукціон") || why.includes("auction")) return "Перевірити CPM та ринковий контекст. Якщо CTR і CR стабільні, не робити зайвих правок у кампанії лише через дорожчий аукціон.";
  return "Відкрити кампанію й звірити поточні 3 дні з baseline: CPL, results/day, CPM, CTR і Click→Result CR. Якщо сьогодні вже є recovery — не робити різких змін.";
}

export default async function AlertDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const data = await getPerformanceAlertById(id);
  if (!data) notFound();

  const { alert, config } = data;
  const details = alert.details || {};
  const notes = Array.isArray(details.notes) ? details.notes as Array<{ by?: string; note?: string; at?: string }> : [];
  const status = alert.resolved_at ? "Resolved" : alert.acknowledged_at ? "In progress" : "Waiting ACK";
  const statusClass = alert.resolved_at ? "ok" : alert.acknowledged_at ? "warn" : alert.severity === "critical" ? "bad" : "warn";

  const recent3 = metric(details.recent3);
  const baseline7 = metric(details.baseline7);
  const today = metric(details.today);
  const diagStored = diagnosis(details.diagnosis);
  const hasRecent = recent3.spend > 0 || recent3.results > 0 || recent3.clicks > 0;
  const hasBase = baseline7.spend > 0 || baseline7.results > 0 || baseline7.clicks > 0;
  const hasToday = today.spend > 0 || today.results > 0 || today.clicks > 0;
  const hasV4Diag = Boolean(details.diagnosis && typeof details.diagnosis === "object");

  const recentCpl = Number(details.recentCpl || cpl(recent3) || 0);
  const baselineCpl = Number(details.baselineCpl || cpl(baseline7) || 0);
  const storedGrowth = Number(details.growth || 0);
  const cplChange = hasV4Diag ? Number(diagStored.cplChange || 0) : (storedGrowth > 2 ? storedGrowth / 100 : storedGrowth || ratio(recentCpl, baselineCpl));
  const cpmChange = hasV4Diag ? Number(diagStored.cpmChange || 0) : ratio(cpm(recent3), cpm(baseline7));
  const ctrChange = hasV4Diag ? Number(diagStored.ctrChange || 0) : ratio(ctr(recent3), ctr(baseline7));
  const crChange = hasV4Diag ? Number(diagStored.crChange || 0) : ratio(cr(recent3), cr(baseline7));

  const campaignName = String(details.campaignName || details.campaign_name || "—");
  const actionType = String(details.actionType || details.action_type || "—");
  const reason = diagStored.reason || (hasV4Diag ? "Змішаний сигнал / mixed signal" : "Legacy alert: root-cause diagnosis не був збережений");
  const confidence = diagStored.confidence || (hasV4Diag ? "LOW" : "N/A");
  const volumeDrop = Number(details.volumeDrop || 0);

  const triggerParts: string[] = [];
  if (recentCpl > 0 && baselineCpl > 0) triggerParts.push(`CPL ${money(baselineCpl)} → ${money(recentCpl)} (${pct(cplChange)})`);
  if (volumeDrop > 0) triggerParts.push(`Results/day просіли приблизно на ${Math.round(volumeDrop * 100)}%`);
  if (alert.alert_type.includes("CREATIVE_WASTE")) triggerParts.push(`creative витратив ${money(Number(details.spend || 0))} без result`);
  if (alert.alert_type.includes("ADSET")) triggerParts.push(`ad set: spend ${money(Number(details.spend || 0))}, results ${Number(details.results || 0)}`);
  if (alert.alert_type.includes("SPEND_WITHOUT_RESULTS")) triggerParts.push(`сьогодні є spend, але 0 results`);
  const triggerText = triggerParts.length ? triggerParts.join(" · ") : "Alert спрацював за rule цього типу; нижче показані дані, які були збережені в момент detect.";

  const diagnosticAvailable = hasV4Diag || ((recent3.impressions || 0) > 0 && (baseline7.impressions || 0) > 0);
  const detailEntries = Object.entries(details).filter(([key]) => ![
    "notes", "management_escalated_at", "recent3", "baseline7", "today", "diagnosis", "campaignName", "campaign_name", "actionType", "action_type", "recentCpl", "baselineCpl", "growth", "volumeDrop"
  ].includes(key)).slice(0, 18);

  return <main className="adminShell">
    <aside className="sidebar">
      <div className="brandBlock"><div className="brandMark">//</div><div><strong>PTS</strong><span>COOPERATION</span></div></div>
      <nav className="sideNav"><Link href="/" className="sideNavItem"><span>⌂</span>Overview</Link><Link href="/tasks" className="sideNavItem active"><span>⚡</span>Performance OS</Link><Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link></nav>
    </aside>
    <section className="workspace">
      <header className="topBar"><div className="searchGhost">Alert #{alert.id} · Incident lifecycle</div><div className="systemOnline"><span className="dot ok"/>live</div></header>
      <div className="shell performanceShell">
        <div className="setupHero"><Link href="/tasks" className="backLink">← Performance Command Center</Link></div>
        <section className="performanceHero">
          <div><div className="eyebrow purpleText">INCIDENT CONTROL · ALERT #{alert.id}</div><h1>{alert.title}</h1><p className="subtitle">{config?.project_name || alert.meta_account_id} · {config?.targetologist_telegram || "Без відповідального"}</p></div>
          <div className="heroStatusCluster"><div className="heroStatusDot"/><div><strong className={statusClass}>{status}</strong><span>{alert.severity.toUpperCase()} · {alert.alert_type}</span></div></div>
        </section>

        <section className="commandMetrics">
          <div className="commandMetric danger"><span className="commandMetricIcon">!</span><div><small>SEVERITY</small><strong style={{fontSize:20}}>{alert.severity}</strong><p>{alert.alert_type}</p></div></div>
          <div className="commandMetric progress"><span className="commandMetricIcon">⏱</span><div><small>TIME TO ACK</small><strong>{duration(alert.first_seen_at, alert.acknowledged_at)}</strong><p>detect → acknowledge</p></div></div>
          <div className="commandMetric success"><span className="commandMetricIcon">✓</span><div><small>TIME TO DONE</small><strong>{duration(alert.first_seen_at, alert.resolved_at)}</strong><p>detect → resolve</p></div></div>
          <div className="commandMetric warning"><span className="commandMetricIcon">◎</span><div><small>OWNER</small><strong style={{fontSize:16}}>{config?.targetologist_telegram || "—"}</strong><p>{config?.project_name || "Project"}</p></div></div>
        </section>

        <section className="commandPanel" style={{marginBottom:12,borderColor:alert.severity === "critical" ? "#4b202c" : "#49371f"}}>
          <div className="commandPanelHead"><div><span className="eyebrow purpleText">WHY THIS ALERT</span><h2>Чому спрацював alert</h2><p>Не raw JSON, а конкретна логіка detect.</p></div></div>
          <div style={{padding:16,display:"grid",gap:12}}>
            <div style={{padding:"14px 16px",border:"1px solid #2c2634",borderRadius:12,background:"#0b0a10"}}><strong style={{fontSize:15}}>Тригер / Trigger</strong><p style={{margin:"7px 0 0",color:"#d3ccd8",fontSize:13,lineHeight:1.55}}>{triggerText}</p></div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:8}}>
              <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>CPL</div><strong>{pct(cplChange)}</strong><p style={{fontSize:9,color:"#777181"}}>{baselineCpl > 0 ? `${money(baselineCpl)} → ${money(recentCpl)}` : "недостатньо baseline"}</p></div>
              <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>CPM</div><strong>{diagnosticAvailable ? pct(cpmChange) : "—"}</strong><p style={{fontSize:9,color:"#777181"}}>auction pressure</p></div>
              <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>CTR</div><strong>{diagnosticAvailable ? pct(ctrChange) : "—"}</strong><p style={{fontSize:9,color:"#777181"}}>creative signal</p></div>
              <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>Click → Result CR</div><strong>{diagnosticAvailable ? pct(crChange) : "—"}</strong><p style={{fontSize:9,color:"#777181"}}>post-click signal</p></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1.2fr .8fr",gap:10}}>
              <div style={{padding:"14px 16px",border:"1px solid #2d2440",borderRadius:12,background:"rgba(180,76,255,.04)"}}><span className="eyebrow purpleText">DIAGNOSIS</span><h3 style={{margin:"7px 0 5px",fontSize:17}}>{reason}</h3><p style={{margin:0,color:"#85808b",fontSize:10}}>Confidence: <b style={{color:"#fff"}}>{confidence}</b>{!diagnosticAvailable ? " · цей старий alert не зберіг CPM/CTR/CR, тому точну root-cause діагностику заднім числом зробити неможливо" : ""}</p></div>
              <div style={{padding:"14px 16px",border:"1px solid #25342d",borderRadius:12,background:"rgba(87,239,154,.035)"}}><span className="eyebrow" style={{color:"#57ef9a"}}>NEXT ACTION</span><p style={{margin:"7px 0 0",fontSize:11,lineHeight:1.5,color:"#d6d1da"}}>{nextAction(alert.alert_type, reason)}</p></div>
            </div>
          </div>
        </section>

        {(hasRecent || hasBase || hasToday) ? <section className="commandPanel" style={{marginBottom:12}}>
          <div className="commandPanelHead"><div><span className="eyebrow purpleText">PERFORMANCE WINDOWS</span><h2>Які дані порівнював бот</h2><p>Однаковий result action: <code>{actionType}</code>{campaignName !== "—" ? ` · Campaign: ${campaignName}` : ""}</p></div></div>
          <div className="projectHealthGrid" style={{gridTemplateColumns:"repeat(3,minmax(0,1fr))"}}>
            <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>TODAY · recovery/emergency</div><strong style={{fontSize:16}}>{money(today.spend)} · {today.results || 0} results</strong><p style={{fontSize:10,color:"#777181"}}>CPL {today.results ? money(cpl(today)) : "—"} · clicks {today.clicks || 0}</p></div>
            <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>RECENT 3D · current</div><strong style={{fontSize:16}}>{money(recent3.spend)} · {recent3.results || 0} results</strong><p style={{fontSize:10,color:"#777181"}}>CPL {recent3.results ? money(cpl(recent3)) : "—"} · clicks {recent3.clicks || 0}</p></div>
            <div className="projectHealthCard"><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>BASELINE 7D · reference</div><strong style={{fontSize:16}}>{money(baseline7.spend)} · {baseline7.results || 0} results</strong><p style={{fontSize:10,color:"#777181"}}>CPL {baseline7.results ? money(cpl(baseline7)) : "—"} · clicks {baseline7.clicks || 0}</p></div>
          </div>
        </section> : null}

        <section className="performanceOverviewGrid">
          <div className="commandPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">LIFECYCLE</span><h2>Історія інциденту</h2></div></div>
            <div className="timelineStream">
              <div className="timelineEvent"><span className="timelineDot critical"/><div><div className="timelineTop"><strong>Detected</strong><span>{fmt(alert.first_seen_at)}</span></div><p>Система створила alert.</p></div></div>
              {alert.acknowledged_at ? <div className="timelineEvent"><span className="timelineDot active"/><div><div className="timelineTop"><strong>ACK · Взято в роботу</strong><span>{fmt(alert.acknowledged_at)}</span></div><p>{alert.acknowledged_by || config?.targetologist_telegram || "Команда"}</p></div></div> : null}
              {notes.map((note, index) => <div className="timelineEvent" key={`${note.at}-${index}`}><span className="timelineDot active"/><div><div className="timelineTop"><strong>Optimization note</strong><span>{fmt(note.at)}</span></div><p>{note.note || "—"}</p><small>{note.by || ""}</small></div></div>)}
              {alert.resolved_at ? <div className="timelineEvent"><span className="timelineDot done"/><div><div className="timelineTop"><strong>Resolved</strong><span>{fmt(alert.resolved_at)}</span></div><p>Задачу закрито.</p></div></div> : null}
            </div>
          </div>

          <div className="commandPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">INCIDENT DATA</span><h2>Контекст alert</h2></div></div>
            <div className="miniSignalGrid" style={{gridTemplateColumns:"1fr"}}>
              <div><span>Project</span><strong>{config?.project_name || alert.meta_account_id}</strong></div>
              <div><span>Campaign</span><strong>{campaignName}</strong></div>
              <div><span>Result action</span><strong><code>{actionType}</code></strong></div>
              <div><span>Meta account</span><strong><code>{alert.meta_account_id}</code></strong></div>
              <div><span>First seen</span><strong>{fmt(alert.first_seen_at)}</strong></div>
              <div><span>Last seen</span><strong>{fmt(alert.last_seen_at)}</strong></div>
              <div><span>Status</span><strong className={statusClass}>{status}</strong></div>
            </div>
          </div>
        </section>

        {detailEntries.length ? <section className="commandPanel" style={{marginBottom:12}}><div className="commandPanelHead"><div><span className="eyebrow purpleText">TECHNICAL DETAILS</span><h2>Додаткові raw signals</h2><p>Для дебагу. Основне пояснення alert вже показано вище.</p></div></div><div className="projectHealthGrid">{detailEntries.map(([key,value]) => <div className="projectHealthCard" key={key}><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>{key}</div><strong style={{fontSize:13,wordBreak:"break-word"}}>{valueText(value)}</strong></div>)}</div></section> : null}

        {config ? <section className="commandPanel"><div className="commandPanelHead"><div><span className="eyebrow purpleText">PROJECT CONTEXT</span><h2>Перейти до проєкту</h2><p>30-денна історія, recurring issues та SLA.</p></div><Link className="runButton primaryAction" href={`/tasks/project/${encodeURIComponent(alert.meta_account_id)}`}>Відкрити Project Control →</Link></div></section> : null}
      </div>
    </section>
  </main>;
}
