import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getStoredAccount } from "@/lib/store";
import { createProjectReport, REPORTING_GOALS } from "@/lib/google-reporting-user";
import { getReportingConfig, upsertReportingConfig } from "@/lib/reporting-store";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";

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

export default async function ReportingSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { accountId } = await params;
  const query = await searchParams;
  const decodedId = decodeURIComponent(accountId);
  const [account, existing] = await Promise.all([
    getStoredAccount(decodedId),
    getReportingConfig(decodedId),
  ]);

  if (!account) {
    return (
      <main className="shell narrowShell">
        <Link href="/" className="backLink">← До кабінетів</Link>
        <section className="panel setupPanel">
          <div className="empty bad">Рекламний кабінет не знайдено.</div>
        </section>
      </main>
    );
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

    try {
      const report = await createProjectReport({ projectName, goalKey, customGoal, startDate });
      await upsertReportingConfig({
        meta_account_id: currentAccountId,
        project_name: projectName,
        goal_key: goalKey,
        goal_label: report.goalLabel,
        currency: null,
        timezone: "Europe/Kyiv",
        report_start_date: report.startDate,
        report_end_date: report.endDate,
        report_file_id: report.fileId,
        report_url: report.url,
        status: "configured",
      });
      revalidatePath("/");
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(errorMessage)}`);
    }

    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent("Звіт створено. Формули активовані.")}`);
  }

  async function syncMeta(formData: FormData) {
    "use server";

    const since = String(formData.get("since") || "");
    const until = String(formData.get("until") || "");
    try {
      const config = await getReportingConfig(currentAccountId);
      if (!config) throw new Error("Спочатку потрібно створити Google звіт для цього кабінету.");
      if (!since || !until) throw new Error("Вкажіть період синхронізації.");
      if (since > until) throw new Error("Дата початку не може бути пізніше дати завершення.");

      const result = await syncMetaReporting({
        accountId: currentAccountId,
        spreadsheetId: config.report_file_id,
        since,
        until,
      });

      const unmapped = result.unmappedCampaigns.length;
      const message = `Meta sync: ${result.insightRows} campaign-day rows, ${result.mappedCampaigns.length} mapped campaigns, ${unmapped} unmapped.`;
      revalidatePath(`/reporting/${encodeURIComponent(currentAccountId)}`);
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?message=${encodeURIComponent(message)}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(errorMessage)}`);
    }
  }

  return (
    <main className="shell narrowShell">
      <Link href="/" className="backLink">← До кабінетів</Link>
      <div className="setupHero">
        <div className="eyebrow">PTS Reporting · Project Setup</div>
        <h1>Налаштувати звітність</h1>
        <p className="subtitle">
          Одна Google Таблиця = один проєкт. Meta автоматично заповнює лише B (ліди/результати) та E (витрати), менеджери працюють з G/H/J/L/M/O, решта KPI та weekly totals рахуються формулами.
        </p>
      </div>

      <section className="panel setupPanel">
        <div className="panelHead">
          <div>
            <strong>{account.name}</strong>
            <div className="eyebrow setupAccountId">{account.meta_account_id}</div>
          </div>
          <span className={`statusPill ${existing ? "ok" : "warn"}`}>
            {existing ? "Reporting configured" : "Needs setup"}
          </span>
        </div>

        {existing ? (
          <div className="configuredBox">
            <div>
              <div className="eyebrow">Поточний звіт</div>
              <h2>{existing.project_name}</h2>
              <p className="subtitle">Кінцева ціль: <strong>{existing.goal_label}</strong></p>
            </div>
            <a className="runButton linkButton" href={existing.report_url} target="_blank" rel="noreferrer">
              Відкрити Google Sheet
            </a>
          </div>
        ) : null}

        {query.error ? <div className="formError">{query.error}</div> : null}
        {query.message ? <div className="empty good">{query.message}</div> : null}

        {existing ? (
          <form action={syncMeta} className="setupForm">
            <div className="eyebrow">Meta Ads → Daily reporting</div>
            <h2>Синхронізувати дані кабінету</h2>
            <p className="subtitle">
              Mapping: Direct/Messenger → Direct / Messenger; LeadForm/Lead Form → Lead Form; Quiz → Quiz; Site/Website/Web → Site. Невідомі назви не записуються навмання.
            </p>
            <label>
              <span>Період від</span>
              <input type="date" name="since" defaultValue={previousMonth.since} required />
            </label>
            <label>
              <span>Період до</span>
              <input type="date" name="until" defaultValue={previousMonth.until} required />
            </label>
            <div className="setupActions">
              <button className="runButton primaryAction" type="submit">Синхронізувати Meta → звіт</button>
            </div>
          </form>
        ) : null}

        <form action={createReport} className="setupForm">
          <label>
            <span>Назва проєкту</span>
            <input name="projectName" defaultValue={existing?.project_name || account.name} required />
          </label>

          <label>
            <span>Кінцева ціль запусків</span>
            <select name="goalKey" defaultValue={existing?.goal_key || "sale"}>
              {REPORTING_GOALS.map((goal) => (
                <option key={goal.key} value={goal.key}>{goal.label}</option>
              ))}
            </select>
            <small>Фінальна ціль автоматично змінюється в weekly, daily та monthly блоках: наприклад Продаж → Реєстрації.</small>
          </label>

          <label>
            <span>Інша ціль, якщо обрано «Інше»</span>
            <input name="customGoal" placeholder="Наприклад: Депозит, Договір, Оплата" />
          </label>

          <label>
            <span>З якої дати вести звітність проєкту</span>
            <input type="date" name="startDate" defaultValue={existing?.report_start_date || todayIso()} required />
            <small>Система сама розкладе дату по періодах 01–07, 08–14, 15–21, 22–28 та 29–кінець місяця.</small>
          </label>

          <div className="setupActions">
            <button className="runButton primaryAction" type="submit">
              {existing ? "Створити новий звіт" : "Створити Google звіт"}
            </button>
            <Link href="/" className="secondaryButton">Скасувати</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
