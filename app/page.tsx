import { countRejectedAds, listStoredAccounts } from "@/lib/store";

export const dynamic = "force-dynamic";

function statusClass(kind: string) {
  if (kind === "active") return "ok";
  if (kind === "warning") return "warn";
  return "bad";
}

export default async function Dashboard() {
  let accounts = [] as Awaited<ReturnType<typeof listStoredAccounts>>;
  let rejectedCount = 0;
  let error = "";

  try {
    [accounts, rejectedCount] = await Promise.all([listStoredAccounts(), countRejectedAds()]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const active = accounts.filter((a) => a.status_kind === "active").length;
  const payment = accounts.filter((a) => a.status_kind === "payment").length;
  const problems = accounts.filter((a) => a.status_kind !== "active").length;

  return (
    <main className="shell">
      <div className="eyebrow">PTS Cooperation · Internal Tool</div>
      <h1>Ads Health Monitor</h1>
      <p className="subtitle">Централізований health-check рекламних кабінетів Meta та моніторинг нових rejected ads. Telegram отримує тільки зміни статусів, а не повтори кожні 10 хвилин.</p>

      <section className="grid">
        <div className="card"><div className="eyebrow">Accounts</div><div className="metric">{accounts.length}</div></div>
        <div className="card"><div className="eyebrow">Active</div><div className="metric ok">{active}</div></div>
        <div className="card"><div className="eyebrow">Problems</div><div className="metric bad">{problems}</div></div>
        <div className="card"><div className="eyebrow">Payment states</div><div className="metric warn">{payment}</div></div>
      </section>

      <section className="panel">
        <div className="panelHead">
          <div><strong>Meta ad accounts</strong><div className="eyebrow" style={{marginTop:6}}>Known rejected ads: {rejectedCount}</div></div>
          <span className="statusPill">Auto-check · every 10 min</span>
        </div>
        {error ? <div className="empty bad">{error}</div> : accounts.length === 0 ? (
          <div className="empty">Поки немає даних. Після налаштування ENV запусти <code>/api/monitor</code> один раз — система синхронізує всі РК з BM.</div>
        ) : (
          <table>
            <thead><tr><th>Account</th><th>ID</th><th>Status</th><th>Last check</th></tr></thead>
            <tbody>
              {accounts.map((account) => {
                const cls = statusClass(account.status_kind);
                return <tr key={account.meta_account_id}>
                  <td><strong>{account.name}</strong></td>
                  <td><code>{account.meta_account_id}</code></td>
                  <td className={cls}><span className={`dot ${cls}`} />{account.status_label}</td>
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
