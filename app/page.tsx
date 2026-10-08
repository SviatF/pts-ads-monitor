import Link from "next/link";
import { revalidatePath } from "next/cache";
import { countRejectedAds, listStoredAccounts } from "@/lib/store";
import { listReportingConfigs } from "@/lib/reporting-store";
import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { runMonitor } from "@/lib/run-monitor";
import { endProjectCooperation, listEndedProjects } from "@/lib/project-lifecycle";
import { getGoogleOAuthStatus } from "@/lib/google-oauth-store";
import { getReportingRepairSummary, resetReportingRepairQueue } from "@/lib/reporting-repair-store";

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

async function resetReportingAuditAction() {
  "use server";
  await resetReportingRepairQueue();
  revalidatePath("/");
}

async function endCooperationAction(formData: FormData) {
  "use server";
  const accountId = String(formData.get("meta_account_id") || "").trim();
  if (!accountId) return;
  await endProjectCooperation(accountId, "dashboard");
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/task-manager");
}

export default async function Dashboard() {
  let accounts = [] as Awaited<ReturnType<typeof listStoredAccounts>>;
  let reportingConfigs = [] as Awaited<ReturnType<typeof listReportingConfigs>>;
  let monitoringConfigs = [] as Awaited<ReturnType<typeof listPerformanceMonitoringConfigs>>;
  let endedProjects = [] as Awaited<ReturnType<typeof listEndedProjects>>;
  let googleOAuthStatus: Awaited<ReturnType<typeof getGoogleOAuthStatus>> | null = null;
  let reportingRepair = { rows: [], counts: {} } as Awaited<ReturnType<typeof getReportingRepairSummary>>;
  let rejectedCount = 0;
  let error = "";

  try {
    [accounts, rejectedCount, reportingConfigs, monitoringConfigs, endedProjects, googleOAuthStatus, reportingRepair] = await Promise.all([
      listStoredAccounts(),
      countRejectedAds(),
      listReportingConfigs(),
      listPerformanceMonitoringConfigs(),
      listEndedProjects(),
      getGoogleOAuthStatus(),
      getReportingRepairSummary(),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const endedByAccount = new Map(endedProjects.map((item) => [item.meta_account_id, item]));
  const configuredReporting = reportingConfigs.filter((item) => item.status === "configured");
  const active = accounts.filter((a) => a.status_kind === "active" && !endedByAccount.has(a.meta_account_id)).length;
  const problems = accounts.filter((a) => a.status_kind !== "active" && !endedByAccount.has(a.meta_account_id)).length;
  const reportingByAccount = new Map(configuredReporting.map((config) => [config.meta_account_id, config]));
  const monitoringByAccount = new Map(monitoringConfigs.map((config) => [config.meta_account_id, config]));
  const needsSetup = accounts.filter((account) => !endedByAccount.has(account.meta_account_id) && !reportingByAccount.has(account.meta_account_id) && !monitoringByAccount.has(account.meta_account_id));
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
          <Link href="/tasks" className="sideNavItem"><span>⚡</span>Performance OS</Link>\n          <Link href="/task-manager" className="sideNavItem"><span>✓</span>Task Manager</Link>
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

          {reportingRepair.rows.length ? (
            <section className="panel" style={{ marginBottom: 12 }}>
              <div className="panelHead">
                <div>
                  <strong>Reporting Data Audit</strong>
                  <div className="eyebrow panelSub">
                    Повний self-heal усіх configured Google reports: Meta → daily/weekly/monthly/campaign sheets → автоматична перевірка totals.
                  </div>
                </div>
                <form action={resetReportingAuditAction}>
                  <button className="runButton" type="submit">Повторити аудит усіх</button>
                </form>
              </div>
              <div className="reportingActions" style={{ marginTop: 10 }}>
                <span className="statusPill ok">Healthy {reportingRepair.counts.healthy || 0}</span>
                <span className="statusPill warn">Pending {reportingRepair.counts.pending || 0}</span>
                <span className="statusPill warn">Running {reportingRepair.counts.running || 0}</span>
                <span className="statusPill warn">Mismatch {reportingRepair.counts.mismatch || 0}</span>
                <span className="statusPill bad">Failed {reportingRepair.counts.failed || 0}</span>
              </div>
              <div className="tableWrap" style={{ marginTop: 12 }}>
                <table>
                  <thead><tr><th>Project</th><th>Status</th><th>Repair range</th><th>Meta expected</th><th>Sheet verified</th><th>Attempts</th></tr></thead>
                  <tbody>
                    {reportingRepair.rows.map((row) => (
                      <tr key={row.id}>
                        <td><strong>{row.project_name}</strong></td>
                        <td className={row.status === "healthy" ? "ok" : row.status === "failed" ? "bad" : "warn"}>{row.status.toUpperCase()}</td>
                        <td>{row.repair_from || "—"} → {row.repair_to || "—"}</td>
                        <td>{row.expected_results ?? "—"} results · {row.expected_spend ?? "—"} spend</td>
                        <td>{row.verified_results ?? "—"} results · {row.verified_spend ?? "—"} spend</td>
                        <td>{row.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {googleOAuthStatus?.last_error ? (
            <section className="panel" style={{ marginBottom: 12, borderColor: "rgba(255,91,120,.4)" }}>
              <div className="panelHead">
                <div>
                  <strong className="bad">Google OAuth потребує уваги</strong>
                  <div className="eyebrow panelSub">Reporting не зможе оновлювати Google Sheets, доки Google account не буде перепідключено.</div>
                </div>
                <a className="runButton dangerAction" href="/api/google/oauth/start">Перепідключити Google</a>
              </div>
            </section>
          ) : null}

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
                  <thead><tr><th>Account</th><th>ID</th><th>Status</th><th>Performance Control</th><th>Reporting</th><th>Last check</th><th>Cooperation</th></tr></thead>
                  <tbody>
                    {accounts.map((account) => {
                      const cls = statusClass(account.status_kind);
                      const reporting = reportingByAccount.get(account.meta_account_id);
                      const monitoring = monitoringByAccount.get(account.meta_account_id);
                      const reportingHref = `/reporting/${encodeURIComponent(account.meta_account_id)}`;
                      const monitoringHref = `/monitoring/${encodeURIComponent(account.meta_account_id)}`;
                      const ended = endedByAccount.get(account.meta_account_id);
                      return <tr key={account.meta_account_id}>
                        <td><strong>{account.name}</strong></td>
                        <td><code>{account.meta_account_id}</code></td>
                        <td className={ended ? "bad" : cls}>
                          <span className={`dot ${ended ? "bad" : cls}`} />
                          {ended ? "Співпрацю завершено" : account.status_label}
                        </td>
                        <td>
                          {ended ? <span className="bad">STOPPED</span> : monitoring?.enabled ? (
                            <div className="reportingCell"><span className="ok">ON · {monitoring.source === "reporting" ? "via Reporting" : "Monitor only"}</span><div className="reportingActions"><Link className="inlineSetup" href={monitoringHref}>Керувати</Link></div></div>
                          ) : <Link className="inlineSetup" href={monitoringHref}>Підключити</Link>}
                        </td>
                        <td>
                          {ended ? (
                            <div className="reportingCell">
                              <span className="bad">STOPPED</span>
                              {reporting?.report_url ? <div className="reportingActions"><a href={reporting.report_url} target="_blank" rel="noreferrer">Open Sheet ↗</a></div> : null}
                            </div>
                          ) : reporting ? (
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
                        <td>
                          {ended ? (
                            <div className="reportingCell">
                              <span className="bad">ENDED</span>
                              <small>{ended.ended_at ? new Date(ended.ended_at).toLocaleString("uk-UA") : ""}</small>
                            </div>
                          ) : (
                            <form action={endCooperationAction}>
                              <input type="hidden" name="meta_account_id" value={account.meta_account_id} />
                              <button className="endCooperationButton" type="submit">ЗАКІНЧИЛИ СПІВПРАЦЮ</button>
                            </form>
                          )}
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <footer className="dashboardFooter">
            <Link href="/about">About</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
          </footer>
        </div>
      </section>
    </main>
  );
}
