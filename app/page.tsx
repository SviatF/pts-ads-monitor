import Link from "next/link";
import { revalidatePath } from "next/cache";
import { countRejectedAds, listStoredAccounts } from "@/lib/store";
import { listReportingConfigs } from "@/lib/reporting-store";
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
  let rejectedCount = 0;
  let error = "";

  try {
    [accounts, rejectedCount, reportingConfigs] = await Promise.all([
      listStoredAccounts(),
      countRejectedAds(),
      listReportingConfigs(),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const active = accounts.filter((a) => a.status_kind === "active").length;
  const payment = accounts.filter((a) => a.status_kind === "payment").length;
  const problems = accounts.filter((a) => a.status_kind !== "active").length;
  const reportingByAccount = new Map(reportingConfigs.map((config) => [config.meta_account_id, config]));
  const needsReporting = accounts.filter((account) => !reportingByAccount.has(account.meta_account_id));

  return (
    <main className="shell">
      <div className="topRow">
        <div>
          <div className="eyebrow">PTS Cooperation · Internal Tool</div>
          <h1>Ads Health Monitor</h1>
          <p className="subtitle">Централізований health-check рекламних кабінетів Meta, rejected ads і PTS reporting. Новий кабінет автоматично потрапляє в чергу на налаштування звітності.</p>
        </div>
        <form action={runMonitorNow}>
          <button className="runButton" type="submit">Run monitor now</button>
        </form>
      </div>

      <section className="grid dashboardGrid">
        <div className="card"><div className="eyebrow">Accounts</div><div className="metric">{accounts.length}</div></div>
        <div className="card"><div className="eyebrow">Active</div><div className="metric ok">{active}</div></div>
        <div className="card"><div className="eyebrow">Problems</div><div className="metric bad">{problems}</div></div>
        <div className="card"><div className="eyebrow">Payment states</div><div className="metric warn">{payment}</div></div>
        <div className="card"><div className="eyebrow">Reporting setup</div><div className={`metric ${needsReporting.length ? "warn" : "ok"}`}>{reportingConfigs.length}/{accounts.length}</div></div>
      </section>

      {needsReporting.length > 0 ? (
        <section className="panel newAccountsPanel">
          <div className="panelHead">
            <div>
              <strong>Нові кабінети · потрібне налаштування звітності</strong>
              <div className="eyebrow" style={{marginTop:6}}>Monitor already detected them — створення Google Sheet займає один setup</div>
            </div>
            <span className="statusPill warn">{needsReporting.length} needs setup</span>
          </div>
          <div className="newAccountsGrid">
            {needsReporting.map((account) => (
              <div className="newAccountCard" key={account.meta_account_id}>
                <div>
                  <span className="newBadge">NEW</span>
                  <h3>{account.name}</h3>
                  <code>{account.meta_account_id}</code>
                </div>
                <Link className="runButton linkButton" href={`/reporting/${encodeURIComponent(account.meta_account_id)}`}>
                  Налаштувати звітність
                </Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panelHead">
          <div><strong>Meta ad accounts</strong><div className="eyebrow" style={{marginTop:6}}>Known rejected ads: {rejectedCount}</div></div>
          <span className="statusPill">Auto-check · every 10 min</span>
        </div>
        {error ? <div className="empty bad">{error}</div> : accounts.length === 0 ? (
          <div className="empty">Поки немає даних. Натисни <strong>Run monitor now</strong> — система синхронізує всі РК з BM.</div>
        ) : (
          <table>
            <thead><tr><th>Account</th><th>ID</th><th>Status</th><th>Reporting</th><th>Last check</th></tr></thead>
            <tbody>
              {accounts.map((account) => {
                const cls = statusClass(account.status_kind);
                const reporting = reportingByAccount.get(account.meta_account_id);
                return <tr key={account.meta_account_id}>
                  <td><strong>{account.name}</strong></td>
                  <td><code>{account.meta_account_id}</code></td>
                  <td className={cls}><span className={`dot ${cls}`} />{account.status_label}</td>
                  <td>
                    {reporting ? (
                      <div className="reportingCell">
                        <span className="ok">Configured · {reporting.goal_label}</span>
                        <a href={reporting.report_url} target="_blank" rel="noreferrer">Open Sheet ↗</a>
                      </div>
                    ) : (
                      <Link className="inlineSetup" href={`/reporting/${encodeURIComponent(account.meta_account_id)}`}>Налаштувати</Link>
                    )}
                  </td>
                  <td>{new Date(account.last_checked_at).toLocaleString("uk-UA")}</td>
                </tr>;
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
