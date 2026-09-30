import Link from "next/link";
import { notFound } from "next/navigation";
import { getPerformanceAlertById } from "@/lib/performance-dashboard";

export const dynamic = "force-dynamic";

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

export default async function AlertDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const data = await getPerformanceAlertById(id);
  if (!data) notFound();

  const { alert, config } = data;
  const notes = Array.isArray(alert.details?.notes) ? alert.details.notes as Array<{ by?: string; note?: string; at?: string }> : [];
  const status = alert.resolved_at ? "Resolved" : alert.acknowledged_at ? "In progress" : "Waiting ACK";
  const statusClass = alert.resolved_at ? "ok" : alert.acknowledged_at ? "warn" : alert.severity === "critical" ? "bad" : "warn";
  const detailEntries = Object.entries(alert.details || {}).filter(([key]) => !["notes", "management_escalated_at"].includes(key)).slice(0, 20);

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
              <div><span>Meta account</span><strong><code>{alert.meta_account_id}</code></strong></div>
              <div><span>First seen</span><strong>{fmt(alert.first_seen_at)}</strong></div>
              <div><span>Last seen</span><strong>{fmt(alert.last_seen_at)}</strong></div>
              <div><span>Status</span><strong className={statusClass}>{status}</strong></div>
            </div>
          </div>
        </section>

        {detailEntries.length ? <section className="commandPanel" style={{marginBottom:12}}><div className="commandPanelHead"><div><span className="eyebrow purpleText">RAW SIGNALS</span><h2>Метрики та сигнали</h2></div></div><div className="projectHealthGrid">{detailEntries.map(([key,value]) => <div className="projectHealthCard" key={key}><div className="projectOwner" style={{paddingLeft:0,marginTop:0}}>{key}</div><strong style={{fontSize:13}}>{valueText(value)}</strong></div>)}</div></section> : null}

        {config ? <section className="commandPanel"><div className="commandPanelHead"><div><span className="eyebrow purpleText">PROJECT CONTEXT</span><h2>Перейти до проєкту</h2><p>30-денна історія, recurring issues та SLA.</p></div><Link className="runButton primaryAction" href={`/tasks/project/${encodeURIComponent(alert.meta_account_id)}`}>Відкрити Project Control →</Link></div></section> : null}
      </div>
    </section>
  </main>;
}
