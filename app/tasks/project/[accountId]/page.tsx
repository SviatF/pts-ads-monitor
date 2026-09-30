import Link from "next/link";
import { notFound } from "next/navigation";
import { getPerformanceProjectData, healthForAlerts } from "@/lib/performance-dashboard";

export const dynamic = "force-dynamic";

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("uk-UA") : "—";
}

export default async function ProjectControl({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const decoded = decodeURIComponent(accountId);
  const { alerts, config } = await getPerformanceProjectData(decoded, 30);
  if (!config) notFound();

  const open = alerts.filter((a) => !a.resolved_at && ["critical","action_required"].includes(a.severity));
  const warnings = alerts.filter((a) => !a.resolved_at && a.severity === "warning");
  const resolved = alerts.filter((a) => a.resolved_at);
  const health = healthForAlerts(alerts);
  const ackTimes = alerts.filter((a) => a.acknowledged_at && ["critical","action_required"].includes(a.severity)).map((a) => (new Date(a.acknowledged_at as string).getTime() - new Date(a.first_seen_at).getTime()) / 60000).filter((v) => v >= 0 && Number.isFinite(v));
  const doneTimes = resolved.filter((a) => ["critical","action_required"].includes(a.severity)).map((a) => (new Date(a.resolved_at as string).getTime() - new Date(a.first_seen_at).getTime()) / 3600000).filter((v) => v >= 0 && Number.isFinite(v));
  const typeCounts = new Map<string, number>();
  for (const alert of alerts) typeCounts.set(alert.alert_type, (typeCounts.get(alert.alert_type) || 0) + 1);
  const recurring = Array.from(typeCounts.entries()).filter(([,count]) => count >= 3).sort((a,b) => b[1]-a[1]);
  const healthLabel = health === "critical" ? "Critical" : health === "action" ? "Action Required" : health === "watch" ? "Watch" : "Healthy";
  const healthClass = health === "critical" ? "bad" : health === "healthy" ? "ok" : "warn";

  return <main className="adminShell">
    <aside className="sidebar">
      <div className="brandBlock"><div className="brandMark">//</div><div><strong>PTS</strong><span>COOPERATION</span></div></div>
      <nav className="sideNav"><Link href="/" className="sideNavItem"><span>⌂</span>Overview</Link><Link href="/tasks" className="sideNavItem active"><span>⚡</span>Performance OS</Link><Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link></nav>
    </aside>
    <section className="workspace">
      <header className="topBar"><div className="searchGhost">Project Control · {config.project_name}</div><div className="systemOnline"><span className="dot ok"/>30 days live history</div></header>
      <div className="shell performanceShell">
        <div className="setupHero"><Link href="/tasks" className="backLink">← Performance Command Center</Link></div>
        <section className="performanceHero">
          <div><div className="eyebrow purpleText">PROJECT CONTROL · 30 DAYS</div><h1>{config.project_name}</h1><p className="subtitle">{config.targetologist_telegram || "Без відповідального"} · <code>{config.meta_account_id}</code></p></div>
          <div className="heroStatusCluster"><div className="heroStatusDot"/><div><strong className={healthClass}>{healthLabel}</strong><span>{open.length} actionable · {warnings.length} watch</span></div></div>
        </section>

        <section className="commandMetrics">
          <div className="commandMetric danger"><span className="commandMetricIcon">!</span><div><small>OPEN NOW</small><strong>{open.length}</strong><p>actionable задач</p></div></div>
          <div className="commandMetric progress"><span className="commandMetricIcon">⏱</span><div><small>MEDIAN ACK</small><strong>{ackTimes.length ? `${Math.round(median(ackTimes))}m` : "—"}</strong><p>за 30 днів</p></div></div>
          <div className="commandMetric success"><span className="commandMetricIcon">✓</span><div><small>RESOLVED</small><strong>{resolved.length}</strong><p>за 30 днів</p></div></div>
          <div className="commandMetric warning"><span className="commandMetricIcon">◎</span><div><small>MEDIAN RESOLUTION</small><strong>{doneTimes.length ? `${median(doneTimes).toFixed(1)}h` : "—"}</strong><p>detect → done</p></div></div>
        </section>

        <section className="performanceOverviewGrid">
          <div className="commandPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">ACTIVE INCIDENTS</span><h2>Що зараз потребує уваги</h2></div></div>
            <div className="priorityList">{open.length ? open.map((a) => <Link href={`/tasks/alert/${a.id}`} key={a.id} className={`priorityItem ${a.severity === "critical" ? "criticalTask" : "actionTask"}`} style={{textDecoration:"none"}}><div className="priorityRail"/><div className="priorityMain"><div className="priorityTop"><strong>Alert #{a.id}</strong><span className={a.severity === "critical" ? "bad" : "warn"}>{a.severity}</span></div><div className="priorityTitle">{a.title}</div><div className="priorityMeta"><span>{a.alert_type}</span><span>{fmt(a.first_seen_at)}</span></div></div><div className={`taskState ${a.acknowledged_at ? "stateProgress" : "stateWaiting"}`}>{a.acknowledged_at ? "In progress" : "Waiting ACK"}</div></Link>) : <div className="zeroState"><span>✓</span><strong>Активних задач немає</strong><p>Проєкт зараз без actionable alerts.</p></div>}</div>
          </div>

          <div className="commandPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">RECURRING INTELLIGENCE</span><h2>Що повторюється</h2></div></div>
            <div className="miniSignalGrid" style={{gridTemplateColumns:"1fr"}}>{recurring.length ? recurring.map(([type,count]) => <div key={type}><span>{type}</span><strong>{count}× / 30d</strong></div>) : <div><span>Recurring issues</span><strong className="ok">Не виявлено</strong></div>}</div>
          </div>
        </section>

        <section className="commandPanel">
          <div className="commandPanelHead"><div><span className="eyebrow purpleText">INCIDENT HISTORY</span><h2>30-денна історія</h2><p>Кожен alert відкривається окремо з notes та lifecycle.</p></div><span className="statusPill violetPill">{alerts.length} events</span></div>
          <div className="tableWrap"><table><thead><tr><th>Alert</th><th>Тип</th><th>Severity</th><th>Створено</th><th>ACK</th><th>Done</th><th>Status</th></tr></thead><tbody>{alerts.length ? alerts.map((a) => <tr key={a.id}><td><Link href={`/tasks/alert/${a.id}`} className="inlineSetup">#{a.id} · {a.title}</Link></td><td><code>{a.alert_type}</code></td><td className={a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : ""}>{a.severity}</td><td>{fmt(a.first_seen_at)}</td><td>{fmt(a.acknowledged_at)}</td><td>{fmt(a.resolved_at)}</td><td>{a.resolved_at ? <span className="ok">Resolved</span> : a.acknowledged_at ? <span className="warn">In progress</span> : <span className="bad">Open</span>}</td></tr>) : <tr><td colSpan={7} className="empty">За останні 30 днів alerts немає.</td></tr>}</tbody></table></div>
        </section>
      </div>
    </section>
  </main>;
}
