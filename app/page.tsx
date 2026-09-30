import Link from "next/link";
import { revalidatePath } from "next/cache";
import { countRejectedAds, listStoredAccounts } from "@/lib/store";
import { listReportingConfigs } from "@/lib/reporting-store";
import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { runMonitor } from "@/lib/run-monitor";

export const dynamic = "force-dynamic";

function statusClass(kind: string) {
  if (kind === "active") return "ok";
  if (kind === "warning") return "warn";
  return "bad";
}

async function runMonitorNow() {
  "use server";
  await runMonitor();
  revalidatePath("/");
}

export default async function Dashboard() {
  let accounts = [] as Awaited<ReturnType<typeof listStoredAccounts>>;
  let reportingConfigs = [] as Awaited<ReturnType<typeof listReportingConfigs>>;
  let monitoringConfigs = [] as Awaited<ReturnType<typeof listPerformanceMonitoringConfigs>>;
  let rejectedCount = 0;
  let error = "";

  try {
    [accounts, rejectedCount, reportingConfigs, monitoringConfigs] = await Promise.all([
      listStoredAccounts(),
      countRejectedAds(),
      listReportingConfigs(),
      listPerformanceMonitoringConfigs(),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const configuredReporting = reportingConfigs.filter((item) => item.status === "configured");
  const active = accounts.filter((a) => a.status_kind === "active").length;
  const problems = accounts.filter((a) => a.status_kind !== "active").length;
  const reportingByAccount = new Map(configuredReporting.map((config) => [config.meta_account_id, config]));
  const monitoringByAccount = new Map(monitoringConfigs.map((config) => [config.meta_account_id, config]));
  const needsSetup = accounts.filter((account) => !reportingByAccount.has(account.meta_account_id) && !monitoringByAccount.has(account.meta_account_id));
  const monitoringEnabled = monitoringConfigs.filter((item) => item.enabled).length;

  return (
    <main className="adminShell">
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark">//</div>
          <div><strong>PTS</strong><span>COOPERATION</span></div>
        </div>

        <nav className="sideNav">
          <Link href="/" className="sideNavItem active"><span>⌂</span>Overview</Link>
          <Link href="/tasks" className="sideNavItem"><span>⚡</span>Performance OS</Link>
          <a href="#accounts" className="sideNavItem"><span>◉</span>Accounts</a>
          <a href="#reporting" className="sideNavItem"><span>▥</span>Reporting</a>
          <Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link>
          <a href="#accounts" className="sideNavItem"><span>▣</span>Billing</a>
          <a href="#accounts" className="sideNavItem"><span>➤</span>Telegram</a>
        </nav>

        <div className="automationCard">
          <div className="automationHead"><span>Automation</span><b>ON</b></div>
          <div className="automationMeta">Auto-check every 10 min</div>
          <div className="pulseBars" aria-hidden="true">
            {Array.from({ length: 18 }).map((_, i) => <i key={i} style={{ height: `${8 + ((i * 7) % 22)}px` }} />)}
          </div>
          <div className="automationFoot"><span>Monitor</span><span className="ok">● live</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topBar">
          <div className="searchGhost">⌕&nbsp;&nbsp; Search accounts, ID or status...</div>
          <div className="systemOnline"><span className="dot ok" />All systems operational</div>
        </header>

        <div className="shell dashboardShell">
          <div className="topRow heroRow">
            <div>
              <div className="eyebrow purpleText">PTS Cooperation · Internal Tool</div>
              <h1>Ads Health <span className="violetGradient">Monitor</span></h1>
              <p className="subtitle">Для кожного Meta-кабінету окремо обираємо режим: тільки Performance Monitoring або повна PTS Reporting + Monitoring.</p>
            </div>
            <form action={runMonitorNow} className="runMonitorWrap">
              <button className="runButton neonPrimary" type="submit"><span>▶</span> Run monitor now</button>
              <div className="runMeta">Auto-check every 10 min</div>
            </form>
          </div>

          <section className="grid dashboardGrid" id="reporting">
            <div className="card metricCard violetCard"><div className="metricIcon">◉</div><div><div className="eyebrow">Accounts</div><div className="metric">{accounts.length}</div><div className="metricHint">Total Meta ad accounts</div></div></div>
            <div className="card metricCard greenCard"><div className="metricIcon">●</div><div><div className="eyebrow">Active</div><div className="metric ok">{active}</div><div className="metricHint">Actively monitored</div></div></div>
            <div className="card metricCard redCard"><div className="metricIcon">△</div><div><div className="eyebrow">Problems</div><div className="metric bad">{problems}</div><div className="metricHint">Need attention</div></div></div>
            <div className="card metricCard amberCard"><div className="metricIcon">▣</div><div><div className="eyebrow">Performance</div><div className={`metric ${monitoringEnabled ? "ok" : "warn"}`}>{monitoringEnabled}</div><div className="metricHint">Accounts with Performance Control</div></div></div>
            <div className="card metricCard violetCard"><div className="metricIcon">▤</div><div><div className="eyebrow">Reporting</div><div className="metric">{configuredReporting.length}</div><div className="metricHint">Accounts with PTS Google reporting</div></div></div>
          </section>

          {needsSetup.length > 0 ? (
            <section className="panel newAccountsPanel">
              <div className="panelHead">
                <div>
                  <strong>Кабінети · оберіть потрібний режим</strong>
                  <div className="eyebrow panelSub">Якщо клієнт уже має свою звітність — підключаємо тільки моніторинг. Якщо потрібна наша звітність — Reporting автоматично включить Performance Control.</div>
                </div>
                <span className="statusPill warn">{needsSetup.length} needs setup</span>
              </div>
              <div className="newAccountsGrid">
                {needsSetup.map((account) => (
                  <div className="newAccountCard" key={account.meta_account_id}>
                    <div>
                      <span className="newBadge">SETUP</span>
                      <h3>{account.name}</h3>
                      <code>{account.meta_account_id}</code>
                    </div>
                    <div className="reportingActions">
                      <Link className="runButton linkButton" href={`/monitoring/${encodeURIComponent(account.meta_account_id)}`}>Тільки моніторинг</Link>
                      <Link className="runButton linkButton" href={`/reporting/${encodeURIComponent(account.meta_account_id)}`}>Звітність + моніторинг</Link>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel accountsPanel" id="accounts">
            <div className="panelHead">
              <div className="accountsTitle"><div className="panelIcon">◉</div><div><strong>Meta ad accounts</strong><div className="eyebrow panelSub">Known rejected ads: {rejectedCount}</div></div></div>
              <span className="statusPill violetPill">Auto-check · every 10 min</span>
            </div>
            {error ? <div className="empty bad">{error}</div> : accounts.length === 0 ? (
              <div className="empty">Поки немає даних. Натисни <strong>Run monitor now</strong> — система синхронізує всі РК з BM.</div>
            ) : (
              <div className="tableWrap">
                <table>
                  <thead><tr><th>Account</th><th>ID</th><th>Status</th><th>Performance Control</th><th>Reporting</th><th>Last check</th></tr></thead>
                  <tbody>
                    {accounts.map((account) => {
                      const cls = statusClass(account.status_kind);
                      const reporting = reportingByAccount.get(account.meta_account_id);
                      const monitoring = monitoringByAccount.get(account.meta_account_id);
                      const reportingHref = `/reporting/${encodeURIComponent(account.meta_account_id)}`;
                      const monitoringHref = `/monitoring/${encodeURIComponent(account.meta_account_id)}`;
                      return <tr key={account.meta_account_id}>
                        <td><strong>{account.name}</strong></td>
                        <td><code>{account.meta_account_id}</code></td>
                        <td className={cls}><span className={`dot ${cls}`} />{account.status_label}</td>
                        <td>
                          {monitoring?.enabled ? (
                            <div className="reportingCell"><span className="ok">ON · {monitoring.source === "reporting" ? "via Reporting" : "Monitor only"}</span><div className="reportingActions"><Link className="inlineSetup" href={monitoringHref}>Керувати</Link></div></div>
                          ) : <Link className="inlineSetup" href={monitoringHref}>Підключити</Link>}
                        </td>
                        <td>
                          {reporting ? (
                            <div className="reportingCell">
                              <span className="ok">Configured · {reporting.goal_label}</span>
                              <div className="reportingActions">
                                <Link className="inlineSetup" href={reportingHref}>Керувати / Sync</Link>
                                <a href={reporting.report_url} target="_blank" rel="noreferrer">Open Sheet ↗</a>
                              </div>
                            </div>
                          ) : <Link className="inlineSetup" href={reportingHref}>Налаштувати звітність</Link>}
                        </td>
                        <td>{new Date(account.last_checked_at).toLocaleString("uk-UA")}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
