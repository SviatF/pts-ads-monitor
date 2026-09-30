import Link from "next/link";
import { getPerformanceDashboardData, healthForAlerts } from "@/lib/performance-dashboard";

export const dynamic = "force-dynamic";

function healthLabel(value: ReturnType<typeof healthForAlerts>) {
  if (value === "critical") return ["🔴", "Critical"];
  if (value === "action") return ["🟠", "Action Required"];
  if (value === "watch") return ["🟡", "Watch"];
  return ["🟢", "Healthy"];
}

function age(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  const hours = Math.max(0, Math.floor(ms / 3600000));
  if (hours < 1) return "<1 год";
  if (hours < 24) return `${hours} год`;
  return `${Math.floor(hours / 24)} дн`;
}

export default async function TasksDashboard() {
  const { alerts, configs, projectNames, owners } = await getPerformanceDashboardData();
  const open = alerts.filter((a) => !a.resolved_at && ["critical", "action_required"].includes(a.severity));
  const inProgress = open.filter((a) => a.acknowledged_at);
  const waiting = open.filter((a) => !a.acknowledged_at);
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const doneToday = alerts.filter((a) => a.resolved_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(a.resolved_at)) === todayKey);
  const overdue = waiting.filter((a) => Date.now() - new Date(a.last_seen_at).getTime() >= 4 * 3600000);

  const byAccount = new Map<string, typeof alerts>();
  for (const alert of alerts.filter((a) => !a.resolved_at)) {
    const rows = byAccount.get(alert.meta_account_id) || [];
    rows.push(alert);
    byAccount.set(alert.meta_account_id, rows);
  }

  return <main className="adminShell">
    <aside className="sidebar">
      <div className="brandBlock"><div className="brandMark">//</div><div><strong>PTS</strong><span>COOPERATION</span></div></div>
      <nav className="sideNav">
        <Link href="/" className="sideNavItem"><span>⌂</span>Overview</Link>
        <Link href="/tasks" className="sideNavItem active"><span>✓</span>Tasks</Link>
        <Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link>
      </nav>
    </aside>
    <section className="workspace">
      <header className="topBar"><div className="searchGhost">Performance OS · Tasks & Health</div><div className="systemOnline"><span className="dot ok"/>live</div></header>
      <div className="shell dashboardShell">
        <div className="topRow heroRow"><div><div className="eyebrow purpleText">PTS Performance OS</div><h1>Tasks <span className="violetGradient">Control</span></h1><p className="subtitle">Один екран для відкритих задач, статусу проєктів і історії дій по alerts.</p></div></div>

        <section className="grid dashboardGrid">
          <div className="card metricCard redCard"><div className="metricIcon">!</div><div><div className="eyebrow">Open</div><div className="metric bad">{open.length}</div><div className="metricHint">Actionable зараз</div></div></div>
          <div className="card metricCard amberCard"><div className="metricIcon">▶</div><div><div className="eyebrow">In progress</div><div className="metric warn">{inProgress.length}</div><div className="metricHint">Взято в роботу</div></div></div>
          <div className="card metricCard greenCard"><div className="metricIcon">✓</div><div><div className="eyebrow">Done today</div><div className="metric ok">{doneToday.length}</div><div className="metricHint">Закрито сьогодні</div></div></div>
          <div className="card metricCard redCard"><div className="metricIcon">⌛</div><div><div className="eyebrow">Overdue</div><div className="metric bad">{overdue.length}</div><div className="metricHint">4+ год без ACK</div></div></div>
          <div className="card metricCard violetCard"><div className="metricIcon">◉</div><div><div className="eyebrow">Projects</div><div className="metric">{configs.filter((c) => c.enabled).length}</div><div className="metricHint">Під контролем</div></div></div>
        </section>

        <section className="panel accountsPanel">
          <div className="panelHead"><div><strong>Project Health</strong><div className="eyebrow panelSub">Стан формується з відкритих alerts</div></div></div>
          <div className="tableWrap"><table><thead><tr><th>Проєкт</th><th>Таргетолог</th><th>Health</th><th>Open</th><th>Critical</th></tr></thead><tbody>
            {configs.filter((c) => c.enabled).map((config) => {
              const rows = byAccount.get(config.meta_account_id) || [];
              const health = healthForAlerts(rows);
              const [icon, label] = healthLabel(health);
              return <tr key={config.meta_account_id}><td><strong>{config.project_name}</strong></td><td>{config.targetologist_telegram || "—"}</td><td>{icon} {label}</td><td>{rows.filter((a) => ["critical","action_required"].includes(a.severity)).length}</td><td className="bad">{rows.filter((a) => a.severity === "critical").length}</td></tr>;
            })}
          </tbody></table></div>
        </section>

        <section className="panel accountsPanel">
          <div className="panelHead"><div><strong>Open Tasks</strong><div className="eyebrow panelSub">Critical та Action Required</div></div><span className="statusPill warn">{open.length} open</span></div>
          <div className="tableWrap"><table><thead><tr><th>Alert</th><th>Проєкт</th><th>Відповідальний</th><th>Проблема</th><th>Status</th><th>Age</th></tr></thead><tbody>
            {open.length ? open.map((a) => <tr key={a.id}><td><code>#{a.id}</code></td><td><strong>{projectNames.get(a.meta_account_id) || a.meta_account_id}</strong></td><td>{owners.get(a.meta_account_id) || "—"}</td><td>{a.severity === "critical" ? "🔴" : "🟠"} {a.title}</td><td>{a.acknowledged_at ? <span className="ok">In progress</span> : <span className="warn">Waiting ACK</span>}</td><td>{age(a.last_seen_at)}</td></tr>) : <tr><td colSpan={6} className="ok">Активних actionable задач немає.</td></tr>}
          </tbody></table></div>
        </section>

        <section className="panel accountsPanel">
          <div className="panelHead"><div><strong>Recent Timeline</strong><div className="eyebrow panelSub">Останні alerts, ACK, notes та закриття</div></div></div>
          <div className="tableWrap"><table><thead><tr><th>Alert</th><th>Проєкт</th><th>Події</th></tr></thead><tbody>
            {alerts.slice(0,30).map((a) => {
              const notes = Array.isArray(a.details?.notes) ? a.details.notes as Array<{note?:string;at?:string}> : [];
              return <tr key={a.id}><td><code>#{a.id}</code><div className="eyebrow">{a.title}</div></td><td>{projectNames.get(a.meta_account_id) || a.meta_account_id}</td><td><div>Створено: {new Date(a.first_seen_at).toLocaleString("uk-UA")}</div>{a.acknowledged_at ? <div className="ok">ACK: {new Date(a.acknowledged_at).toLocaleString("uk-UA")}</div> : null}{notes.slice(-2).map((n,i) => <div key={i}>📝 {n.note || "note"}</div>)}{a.resolved_at ? <div className="ok">✓ Закрито: {new Date(a.resolved_at).toLocaleString("uk-UA")}</div> : null}</td></tr>;
            })}
          </tbody></table></div>
        </section>
      </div>
    </section>
  </main>;
}
