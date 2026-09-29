import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getStoredAccount } from "@/lib/store";
import { createProjectReport, REPORTING_GOALS } from "@/lib/google-reporting";
import { getReportingConfig, upsertReportingConfig } from "@/lib/reporting-store";

export const dynamic = "force-dynamic";

function todayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

export default async function ReportingSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ error?: string }>;
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

  async function createReport(formData: FormData) {
    "use server";

    const projectName = String(formData.get("projectName") || currentAccountName).trim();
    const goalKey = String(formData.get("goalKey") || "sale");
    const customGoal = String(formData.get("customGoal") || "").trim();
    const startDate = String(formData.get("startDate") || todayIso());

    let errorMessage = "";
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
      redirect("/");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    redirect(`/reporting/${encodeURIComponent(currentAccountId)}?error=${encodeURIComponent(errorMessage)}`);
  }

  return (
    <main className="shell narrowShell">
      <Link href="/" className="backLink">← До кабінетів</Link>
      <div className="setupHero">
        <div className="eyebrow">PTS Reporting · Project Setup</div>
        <h1>Налаштувати звітність</h1>
        <p className="subtitle">
          Одна Google Таблиця = один проєкт. Система збереже прихований PTS master, автоматично створюватиме тижневі аркуші та після закриття місяця — місячний аркуш.
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
