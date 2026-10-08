import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getStoredAccount } from "@/lib/store";
import { createProjectReport, REPORTING_GOALS } from "@/lib/google-reporting-user";

import { getReportingConfig, setReportingCurrency, upsertReportingConfig } from "@/lib/reporting-store";
import { getPerformanceMonitoringConfig, upsertPerformanceMonitoringConfig } from "@/lib/performance-config-store";
import { runReportingSync } from "@/lib/reporting-runner";
import { applyReportCurrencyFormats, formatCurrencyAmount, normalizeReportingCurrency, REPORTING_CURRENCIES } from "@/lib/report-currency";

export const dynamic = "force-dynamic";

function todayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

function previousMonthRange() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10) };
}

function isGoogleSheetsRateLimit(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("google api failed (429)") ||
    message.includes("resource_exhausted") ||
    message.includes("rate_limit_exceeded") ||
    message.includes("read requests per minute per user")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withManualSheetsRetry<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!isGoogleSheetsRateLimit(error)) throw error;
    // Google Sheets per-user read quota resets on the minute window.
    // Wait once and rerun the complete operation so a manual full-month repair
    // does not fail halfway with a raw 429.
    await sleep(65_000);
    return await operation();
  }
}

function normalizeTelegramUsername(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export default async function ReportingSetupPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<{ error?: string; message?: string }> }) {
  const { accountId } = await params;
  const query = await searchParams;
  const decodedId = decodeURIComponent(accountId);
  const [account, existing, performanceExisting] = await Promise.all([
    getStoredAccount(decodedId),
    getReportingConfig(decodedId),
    getPerformanceMonitoringConfig(decodedId),
  ]);

  if (!account) {
    return <main className="shell narrowShell"><Link href="/" className="backLink">← До кабінетів</Link><section className="panel setupPanel"><div className="empty bad">Рекламний кабінет не знайдено.</div></section></main>;
  }

  const currentAccountId = account.meta_account_id;
  const currentAccountName = account.name;
  const previousMonth = previousMonthRange();

  async function createReport(formData: FormData) {
    "use server";
    const projectName = String(formData.get("projectName") || currentAccountName).trim();
    const goalKey = String(formData.get("goalKey") || "sale");
    const customGoal = String(formData.get("customGoal") || "").trim();
    const startDate = String(formData.get("startDate") || todayIso());
    const currency = normalizeReportingCurrency(String(formData.get("currency") || existing?.currency || "USD"));
    const targetologistTelegram = normalizeTelegramUsername(String(formData.get("targetologistTelegram") || ""));
    const performanceMonitoringEnabled = String(formData.get("performanceMonitoringEnabled") || "") === "1";
    const creativeWasteMinSpend = Number(formData.get("creativeWasteMinSpend") || 15);
    const creativeWasteCplMultiplier = Number(formData.get("creativeWasteCplMultiplier") || 1.5);
    const cplWarningPct = Number(formData.get("cplWarningPct") || 25);
    const cplCriticalPct = Number(formData.get("cplCriticalPct") || 40);
    const replacing = String(formData.get("replaceExisting") || "") === "1";
    try {
      const report = await createProjectReport({ projectName, goalKey, customGoal, startDate });
      await applyReportCurrencyFormats(report.fileId, currency);
      await upsertReportingConfig({
        meta_account_id: currentAccountId,
        project_name: projectName,
        goal_key: goalKey,
        goal_label: report.goalLabel,
        currency,
        timezone: "Europe/Kyiv",
        report_start_date: report.startDate,
        report_end_date: report.endDate,
        report_file_id: report.fileId,
        report_url: report.url,
        status: "configured",
        targetologist_telegram: targetologistTelegram || null,
        performance_monitoring_enabled: performanceMonitoringEnabled,
        creative_waste_min_spend: Number.isFinite(creativeWasteMinSpend) ? creativeWasteMinSpend : 15,
        creative_waste_cpl_multiplier: Number.isFinite(creativeWasteCplMultiplier) ? creativeWasteCplMultiplier : 1.5,
        cpl_warning_pct: Number.isFinite(cplWarningPct) ? cplWarningPct : 25,
        cpl_critical_pct: Number.isFinite(cplCriticalPct) ? cplCriticalPct : 40,
      });
      revalidatePath("/");
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
    const message = replacing
      ? "Звіт перестворено. Нову Google-таблицю підключено до проєкту; стара таблиця залишилась без змін як backup."
      : "Звіт створено. Формули та Performance Control активовані.";
    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent(message)}`);
  }

  async function saveReportingCurrency(formData: FormData) {
    "use server";
    const currency = normalizeReportingCurrency(String(formData.get("currency") || existing?.currency || "USD"));
    try {
      if (!existing) throw new Error("Спочатку потрібно створити Google звіт.");
      await setReportingCurrency(currentAccountId, currency);
      await applyReportCurrencyFormats(existing.report_file_id, currency);
      revalidatePath("/");
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent(`Валюту звіту змінено на ${currency}. Формат витрат у Google Sheet оновлено.`)}`);
  }

  async function savePerformanceControl(formData: FormData) {
    "use server";
    const projectName = String(formData.get("projectName") || existing?.project_name || currentAccountName).trim();
    const targetologistTelegram = normalizeTelegramUsername(String(formData.get("targetologistTelegram") || ""));
    const creativeWasteMinSpend = Number(formData.get("creativeWasteMinSpend") || 15);
    const creativeWasteCplMultiplier = Number(formData.get("creativeWasteCplMultiplier") || 1.5);
    const cplWarningPct = Number(formData.get("cplWarningPct") || 25);
    const cplCriticalPct = Number(formData.get("cplCriticalPct") || 40);

    try {
      await upsertPerformanceMonitoringConfig({
        meta_account_id: currentAccountId,
        project_name: projectName,
        targetologist_telegram: targetologistTelegram || null,
        enabled: true,
        source: existing ? "reporting" : "monitor_only",
        creative_waste_min_spend: Number.isFinite(creativeWasteMinSpend) ? creativeWasteMinSpend : 15,
        creative_waste_cpl_multiplier: Number.isFinite(creativeWasteCplMultiplier) ? creativeWasteCplMultiplier : 1.5,
        cpl_warning_pct: Number.isFinite(cplWarningPct) ? cplWarningPct : 25,
        cpl_critical_pct: Number.isFinite(cplCriticalPct) ? cplCriticalPct : 40,
      });
      revalidatePath("/");
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }

    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent("Performance Control збережено. Google-таблицю та внесені менеджерами дані не змінено.")}`);
  }

  async function syncMeta(formData: FormData) {
    "use server";
    const since = String(formData.get("since") || "");
    const until = String(formData.get("until") || "");
    let successMessage = "";
    try {
      const config = await getReportingConfig(currentAccountId);
      if (!config) throw new Error("Спочатку потрібно створити Google звіт для цього кабінету.");
      if (!since || !until) throw new Error("Вкажіть період синхронізації.");
      if (since > until) throw new Error("Дата початку не може бути пізніше дати завершення.");
      const { result } = await withManualSheetsRetry(() =>
        runReportingSync(config, {
          since,
          until,
          lifecycleStartDate: since,
        }),
      );
      const unmappedPreview = result.unmappedCampaigns.slice(0, 5).join("; ");
      successMessage = `Meta sync ${since} → ${until}: ${result.insightRows} campaign-day rows; ${result.mappedCampaigns.length} mapped campaigns; results=${result.mappedLeads}; spend=${formatCurrencyAmount(result.mappedSpend, config.currency || "USD")}; ${result.unmappedCampaigns.length} unmapped${unmappedPreview ? ` — ${unmappedPreview}` : ""}.`;
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
    }
    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent(successMessage)}`);
  }

  const performanceTelegram = performanceExisting?.targetologist_telegram || existing?.targetologist_telegram || "";
  const performanceMinSpend = performanceExisting?.creative_waste_min_spend ?? existing?.creative_waste_min_spend ?? 15;
  const performanceMultiplier = performanceExisting?.creative_waste_cpl_multiplier ?? existing?.creative_waste_cpl_multiplier ?? 1.5;
  const performanceWarning = performanceExisting?.cpl_warning_pct ?? existing?.cpl_warning_pct ?? 25;
  const performanceCritical = performanceExisting?.cpl_critical_pct ?? existing?.cpl_critical_pct ?? 40;

  return (
    <main className="shell narrowShell">
      <Link href="/" className="backLink">← До кабінетів</Link>
      <div className="setupHero"><div className="eyebrow">PTS Reporting · Project Setup</div><h1>Налаштувати звітність</h1><p className="subtitle">Одна Google Таблиця = один проєкт. Meta автоматично заповнює C (Результат) та E (Витрати), менеджери вручну вносять B/G/H/J/L/M/O, решта KPI та weekly totals рахуються формулами.</p></div>
      <section className="panel setupPanel">
        <div className="panelHead"><div><strong>{account.name}</strong><div className="eyebrow setupAccountId">{account.meta_account_id}</div></div><span className={`statusPill ${existing ? "ok" : "warn"}`}>{existing ? "Reporting configured" : "Needs setup"}</span></div>
        {existing ? <div className="configuredBox"><div><div className="eyebrow">Поточний звіт</div><h2>{existing.project_name}</h2><p className="subtitle">Кінцева ціль: <strong>{existing.goal_label}</strong> · Валюта: <strong>{normalizeReportingCurrency(existing.currency || "USD")}</strong>{performanceTelegram ? <> · Таргетолог: <strong>{performanceTelegram}</strong></> : null}</p></div><a className="runButton linkButton" href={existing.report_url} target="_blank" rel="noreferrer">Відкрити Google Sheet</a></div> : null}
        {query.error ? <div className="formError">{query.error}</div> : null}
        {query.message ? <div className="empty good">{query.message}</div> : null}
        {existing ? (
          <form action={syncMeta} className="setupForm">
            <div className="eyebrow">Meta Ads → Reporting</div><h2>Синхронізувати звіт</h2>
            <p className="subtitle">Працює тією ж логікою, що й автоматичний sync о 09:00, тільки одразу за вибраний період. Канали: Direct/Messenger → Direct / Messenger; LeadForm/Leads-Form/Lead Form/legacy Leads → Lead Form; Quiz → Quiz; Site/Website/Web → Site. Невідомі campaign names не записуються навмання. Кнопка оновлює тільки автоматичні Meta-поля C (Результат) та E (Витрати); ручні B/G/H/J/L/M/O не змінюються.</p>
            <label><span>Період від</span><input type="date" name="since" defaultValue={previousMonth.since} required /></label>
            <label><span>Період до</span><input type="date" name="until" defaultValue={previousMonth.until} required /></label>
            <div className="setupActions"><button className="runButton primaryAction" type="submit">Синхронізувати звіт</button></div>
          </form>
        ) : null}
        <form action={createReport} className="setupForm">
          <label><span>Назва проєкту</span><input name="projectName" defaultValue={existing?.project_name || account.name} required /></label>
          <label><span>Telegram таргетолога</span><input name="targetologistTelegram" defaultValue={performanceTelegram} placeholder="@username" required /><small>Цього спеціаліста бот тегатиме у performance-alerts для цього кабінету.</small></label>
          <label><span>Кінцева ціль запусків</span><select name="goalKey" defaultValue={existing?.goal_key || "sale"}>{REPORTING_GOALS.map((goal) => <option key={goal.key} value={goal.key}>{goal.label}</option>)}</select><small>Фінальна ціль автоматично змінюється в weekly, daily та monthly блоках.</small></label>
          <label><span>Валюта рекламного кабінету</span><select name="currency" defaultValue={normalizeReportingCurrency(existing?.currency || "USD")} required>{REPORTING_CURRENCIES.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select><small>У цій валюті Meta віддає spend. Вона буде використана у Google Sheet, CPL/CPA та reporting-повідомленнях.</small></label>
          <label><span>Інша ціль, якщо обрано «Інше»</span><input name="customGoal" placeholder="Наприклад: Депозит, Договір, Оплата" /></label>
          <label><span>З якої дати вести звітність проєкту</span><input type="date" name="startDate" defaultValue={existing?.report_start_date || todayIso()} required /><small>Фіксовані 4 періоди місяця: 01–07, 08–15, 16–22, 23–кінець місяця.</small></label>

          <div className="configuredBox">
            <div>
              <div className="eyebrow">PTS Performance Control</div>
              <h2>Автоматичний контроль оптимізації</h2>
              <p className="subtitle">Performance-alerts йдуть тільки у внутрішню Telegram-групу PTS через <code>PERFORMANCE_TELEGRAM_CHAT_ID</code> і тегають закріпленого таргетолога.</p>
            </div>
          </div>
          <input type="hidden" name="performanceMonitoringEnabled" value="1" />
          <label><span>Мін. spend креативу без результату</span><input type="number" name="creativeWasteMinSpend" min="1" step="1" defaultValue={performanceMinSpend} /><small>До цього spend система не робить висновок, що креатив потребує оптимізації.</small></label>
          <label><span>Коефіцієнт Creative Waste відносно CPL інших креативів</span><input type="number" name="creativeWasteCplMultiplier" min="1" step="0.1" defaultValue={performanceMultiplier} /><small>Наприклад 1.5×: якщо інші креативи вже дають ліди, а проблемний спалив ≥1.5 середнього CPL без результату — пушимо.</small></label>
          <label><span>CPL warning, % росту</span><input type="number" name="cplWarningPct" min="5" step="5" defaultValue={performanceWarning} /></label>
          <label><span>CPL critical, % росту</span><input type="number" name="cplCriticalPct" min="10" step="5" defaultValue={performanceCritical} /></label>

          {existing ? (
            <div className="setupActions">
              <button className="runButton primaryAction" type="submit" formAction={saveReportingCurrency}>Зберегти валюту</button>
              <button className="runButton primaryAction" type="submit" formAction={savePerformanceControl}>Зберегти Performance Control</button>
              <span className="subtitle">Змінюються тільки налаштування моніторингу. Google Sheet, формули та дані менеджерів не чіпаємо.</span>
            </div>
          ) : null}

          {existing ? <input type="hidden" name="replaceExisting" value="1" /> : null}
          {existing ? <div className="dangerZone"><div><strong>Перестворити звіт</strong><p>Буде створена нова Google-таблиця з актуального master-шаблону та підключена до цього проєкту. Поточна таблиця не видаляється і залишиться як backup. Використовуйте цю кнопку лише коли справді потрібна нова таблиця.</p></div><button className="runButton dangerAction" type="submit">Перестворити звіт</button></div> : <div className="setupActions"><button className="runButton primaryAction" type="submit">Створити Google звіт</button><Link href="/" className="secondaryButton">Скасувати</Link></div>}
        </form>
      </section>
    </main>
  );
}
