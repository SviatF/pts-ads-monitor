import { getAccountDiscoveryDiagnostics } from "@/lib/meta";

export const dynamic = "force-dynamic";

function AccountList({ title, accounts }: { title: string; accounts: { id: string; name: string; account_status: number }[] }) {
  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panelHead">
        <div>
          <strong>{title}</strong>
          <div className="eyebrow" style={{ marginTop: 6 }}>Count: {accounts.length}</div>
        </div>
      </div>
      {accounts.length === 0 ? (
        <div className="empty">No accounts returned.</div>
      ) : (
        <table>
          <thead><tr><th>Account</th><th>ID</th><th>account_status</th></tr></thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={`${title}-${account.id}`}>
                <td><strong>{account.name}</strong></td>
                <td><code>{account.id}</code></td>
                <td>{account.account_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function DiagnosticsPage() {
  let diagnostics: Awaited<ReturnType<typeof getAccountDiscoveryDiagnostics>> | null = null;
  let error = "";

  try {
    diagnostics = await getAccountDiscoveryDiagnostics();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="shell">
      <div className="eyebrow">PTS Cooperation · Meta API diagnostics</div>
      <h1>Account discovery</h1>
      <p className="subtitle">Показує сирі списки рекламних акаунтів, які Meta API повертає для поточного Business ID та System User token.</p>

      {error ? <div className="panel"><div className="empty bad">{error}</div></div> : diagnostics ? (
        <>
          <section className="grid">
            <div className="card"><div className="eyebrow">Owned</div><div className="metric">{diagnostics.owned.length}</div></div>
            <div className="card"><div className="eyebrow">Client/shared</div><div className="metric">{diagnostics.clients.length}</div></div>
            <div className="card"><div className="eyebrow">/me/adaccounts</div><div className="metric">{diagnostics.directlyAccessible.length}</div></div>
            <div className="card"><div className="eyebrow">Unique total</div><div className="metric">{diagnostics.unique.length}</div></div>
          </section>

          <AccountList title="Owned ad accounts" accounts={diagnostics.owned} />
          <AccountList title="Client/shared ad accounts" accounts={diagnostics.clients} />
          <AccountList title="System User /me/adaccounts" accounts={diagnostics.directlyAccessible} />
          <AccountList title="Unique merged list" accounts={diagnostics.unique} />
        </>
      ) : null}
    </main>
  );
}
