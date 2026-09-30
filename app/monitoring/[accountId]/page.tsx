import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getStoredAccount } from "@/lib/store";
import { getPerformanceMonitoringConfig, setPerformanceMonitoringEnabled, upsertPerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { getReportingConfig } from "@/lib/reporting-store";

export const dynamic = "force-dynamic";

function normalizeTelegramUsername(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export default async function MonitoringSetupPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<{ error?: string; message?: string }> }) {
  const { accountId } = await params;
  const query = await searchParams;
  const decodedId = decodeURIComponent(accountId);
  const [account, existing, reporting] = await Promise.all([
    getStoredAccount(decodedId),
    getPerformanceMonitoringConfig(decodedId),
    getReportingConfig(decodedId),
  ]);

  if (!account) {
    return <main className="shell narrowShell"><Link href="/" className="backLink">← До кабінетів</Link><section className="panel setupPanel"><div className="empty bad">Рекламний кабінет не знайдено.</div></section></main>;
  }

  const currentAccountId = account.meta_account_id;
  const currentAccountName = account.name;

  async function saveMonitoring(formData: FormData) {
    "use server";
    try {
      const projectName = String(formData.get("projectName") || currentAccountName).trim();
      const targetologistTelegram = normalizeTelegramUsername(String(formData.get("targetologistTelegram") || ""));
      const creativeWasteMinSpend = Number(formData.get("creativeWasteMinSpend") || 15);
      const creativeWasteCplMultiplier = Number(formData.get("creativeWasteCplMultiplier") || 1.5);
      const cplWarningPct = Number(formData.get("cplWarningPct") || 25);
      const cplCriticalPct = Number(formData.get("cplCriticalPct") || 40);

      await upsertPerformanceMonitoringConfig({
        meta_account_id: currentAccountId,
        project_name: projectName,
        targetologist_telegram: targetologistTelegram || null,
        enabled: true,
        source: reporting ? "reporting" : "monitor_only",
        creative_waste_min_spend: Number.isFinite(creativeWasteMinSpend) ? creativeWasteMinSpend : 15,
        creative_waste_cpl_multiplier: Number.isFinite(creativeWasteCplMultiplier) ? creativeWasteCplMultiplier : 1.5,
        cpl_warning_pct: Number.isFinite(cplWarningPct) ? cplWarningPct : 25,
        cpl_critical_pct: Number.isFinite(cplCriticalPct) ? cplCriticalPct : 40,
      });
      revalidatePath("/");
      revalidatePath(`/monitoring/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/monitoring/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
    redirect(`/monitoring/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent("Performance Monitoring підключено. Алерти підуть тільки у внутрішній PERFORMANCE_TELEGRAM_CHAT_ID.")}`);
  }

  async function disableMonitoring() {
    "use server";
    try {
      await setPerformanceMonitoringEnabled(currentAccountId, false);
      revalidatePath("/");
      revalidatePath(`/monitoring/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/monitoring/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
    redirect(`/monitoring/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent("Performance Monitoring вимкнено для цього кабінету.")}`);
  }

  return (
    <main className="shell narrowShell">
      <Link href="/" className="backLink">← До кабінетів</Link>
      <div className="setupHero">
        <div className="eyebrow">PTS Performance Control · Monitor only</div>
        <h1>Підключити моніторинг</h1>
        <p className="subtitle">Для кабінетів, які вже мають власну звітність. Google Sheet не створюємо — підключаємо тільки performance-контроль і внутрішні Telegram alerts.</p>
      </div>

      <section className="panel setupPanel">
        <div className="panelHead">
          <div><strong>{account.name}</strong><div className="eyebrow setupAccountId">{account.meta_account_id}</div></div>
          <span className={`statusPill ${existing?.enabled ? "ok" : "warn"}`}>{existing?.enabled ? "Monitoring ON" : "Monitoring OFF"}</span>
        </div>

        {query.error ? <div className="formError">{query.error}</div> : null}
        {query.message ? <div className="empty good">{query.message}</div> : null}

        {reporting ? <div className="configuredBox"><div><div className="eyebrow">Reporting detected</div><h2>Звітність уже підключена</h2><p className="subtitle">Performance Monitoring для reporting-проєктів вмикається автоматично. Тут можна змінити таргетолога та thresholds.</p></div><Link className="runButton linkButton" href={`/reporting/${encodeURIComponent(currentAccountId)}`}>Керувати звітністю</Link></div> : null}

        <form action={saveMonitoring} className="setupForm">
          <label><span>Назва проєкту</span><input name="projectName" defaultValue={existing?.project_name || account.name} required /></label>
          <label><span>Telegram таргетолога</span><input name="targetologistTelegram" defaultValue={existing?.targetologist_telegram || ""} placeholder="@username" required /><small>Цього таргетолога бот тегатиме у внутрішній performance-групі.</small></label>
          <label><span>Мін. spend креативу без результату</span><input type="number" name="creativeWasteMinSpend" min="1" step="1" defaultValue={existing?.creative_waste_min_spend ?? 15} /></label>
          <label><span>Creative Waste multiplier</span><input type="number" name="creativeWasteCplMultiplier" min="1" step="0.1" defaultValue={existing?.creative_waste_cpl_multiplier ?? 1.5} /></label>
          <label><span>CPL warning, %</span><input type="number" name="cplWarningPct" min="5" step="5" defaultValue={existing?.cpl_warning_pct ?? 25} /></label>
          <label><span>CPL critical, %</span><input type="number" name="cplCriticalPct" min="10" step="5" defaultValue={existing?.cpl_critical_pct ?? 40} /></label>
          <div className="setupActions"><button className="runButton primaryAction" type="submit">{existing ? "Зберегти моніторинг" : "Підключити моніторинг"}</button></div>
        </form>

        {existing?.enabled ? <form action={disableMonitoring}><div className="dangerZone"><div><strong>Вимкнути Performance Monitoring</strong><p>Кабінет залишиться в Ads Monitor, але performance-alerts по ньому більше не генеруватимуться.</p></div><button className="runButton dangerAction" type="submit">Вимкнути</button></div></form> : null}
      </section>
    </main>
  );
}
