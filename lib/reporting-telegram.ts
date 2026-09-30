import { getReportingConfig } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import {
  disableReportingTelegramSubscription,
  listReportingTelegramSubscriptions,
  upsertReportingTelegramSubscription,
} from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { acknowledgePerformanceAlert, resolvePerformanceAlert, addPerformanceAlertNote } from "@/lib/performance-alert-store";
import { runPerformanceMonitor } from "@/lib/performance-monitor";
import { sendPerformanceBrief } from "@/lib/performance-brief";
import { sendDailyPerformanceTasks, sendManagementEscalations, sendRecurringProblemReport, sendWeeklyTeamScorecard } from "@/lib/performance-operations";

function commandArgument(text: string, command: string) {
  const match = new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(.+))?$`, "i").exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}

function normalizeAccountId(value: string) {
  return value.trim().replace(/^act_/i, "");
}

function yesterdayKyivIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const local = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

function uaDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

async function resolveConfiguredAccount(raw: string) {
  const normalized = normalizeAccountId(raw.replace(/[<>]/g, ""));
  if (!/^\d{5,25}$/.test(normalized)) return null;
  return await getReportingConfig(`act_${normalized}`) || await getReportingConfig(normalized);
}

export async function notifyAdminReportCreated(input: { projectName: string; accountId: string; reportUrl: string; goalLabel: string }) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await sendTelegramToChat(chatId, `📊 <b>PTS Reporting</b>\n\n✅ Створено звіт для <b>${escapeTelegramHtml(input.projectName)}</b>\nКабінет: <code>${escapeTelegramHtml(input.accountId)}</code>\nЦіль: <b>${escapeTelegramHtml(input.goalLabel)}</b>\n\n<a href="${escapeTelegramHtml(input.reportUrl)}">Відкрити Google Sheet</a>`);
}

export async function handleReportingTelegramCommand(chatId: string, text: string) {
  if (text === "/performance_demo" || text.startsWith("/performance_demo@")) {
    const targetChatId = process.env.PERFORMANCE_TELEGRAM_CHAT_ID;
    if (!targetChatId) {
      await sendTelegramToChat(chatId, "❌ <code>PERFORMANCE_TELEGRAM_CHAT_ID</code> не налаштований у Cloudflare.");
      return true;
    }
    await sendTelegramToChat(
      targetChatId,
      `🧪 <b>PTS PERFORMANCE CONTROL — TEST</b>\n\n✅ Внутрішній performance-чат підключений правильно.\n\nЦе тестове повідомлення. Реальні alerts по CPL, creative waste, spend без results, просадці лідів, якості та ескалаціях будуть приходити тільки сюди.`,
    );
    await sendTelegramToChat(chatId, "✅ Test message відправлено у внутрішній performance-чат.");
    return true;
  }

  if (text === "/performance_test" || text.startsWith("/performance_test@")) {
    const targetChatId = process.env.PERFORMANCE_TELEGRAM_CHAT_ID;
    if (!targetChatId) {
      await sendTelegramToChat(chatId, "❌ Внутрішній performance-чат ще не налаштований.");
      return true;
    }
    await sendTelegramToChat(chatId, "⏳ Запускаю реальну перевірку всіх performance-enabled кабінетів...");
    try {
      const result = await runPerformanceMonitor();
      await sendTelegramToChat(
        chatId,
        `✅ <b>Performance test завершено</b>\n\nКабінетів перевірено: <b>${result.projects}</b>\nAlerts знайдено: <b>${result.alerts}</b>\nПовідомлень відправлено: <b>${result.notifications}</b>${result.errors.length ? `\nПомилки: <b>${result.errors.length}</b>\n<code>${escapeTelegramHtml(result.errors.slice(0, 5).join(" | "))}</code>` : "\nПомилок: <b>0</b>"}`,
      );
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Performance test failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  if (text === "/performance_brief" || text.startsWith("/performance_brief@")) {
    try {
      await sendPerformanceBrief("morning");
      await sendTelegramToChat(chatId, "✅ Morning Performance Brief відправлено у внутрішній performance-чат.");
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Brief failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  if (text === "/performance_brief_evening" || text.startsWith("/performance_brief_evening@")) {
    try {
      await sendPerformanceBrief("evening");
      await sendTelegramToChat(chatId, "✅ End-of-day Performance Brief відправлено у внутрішній performance-чат.");
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Brief failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  if (text === "/tasks_today" || text.startsWith("/tasks_today@")) {
    try {
      const result = await sendDailyPerformanceTasks();
      await sendTelegramToChat(chatId, `✅ Daily Tasks сформовано. Задач: <b>${result.tasks}</b>, таргетологів: <b>${result.targetologists}</b>.`);
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Tasks failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  if (text === "/management_check" || text.startsWith("/management_check@")) {
    try {
      const result = await sendManagementEscalations();
      await sendTelegramToChat(chatId, `✅ Management escalation check завершено. Відправлено: <b>${result.sent}</b>.`);
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Management check failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  if (text === "/management_weekly" || text.startsWith("/management_weekly@")) {
    try {
      const [scorecard, recurring] = await Promise.all([sendWeeklyTeamScorecard(), sendRecurringProblemReport()]);
      await sendTelegramToChat(chatId, `✅ Weekly Management Control сформовано. Спеціалістів: <b>${scorecard.targetologists}</b>, recurring alerts: <b>${recurring.sent}</b>.`);
    } catch (error) {
      await sendTelegramToChat(chatId, `❌ Weekly Management Control failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
    }
    return true;
  }

  const ackArg = commandArgument(text, "perf_ack");
  if (ackArg !== null) {
    const id = Number(ackArg);
    if (!Number.isInteger(id) || id <= 0) {
      await sendTelegramToChat(chatId, "❌ Формат: <code>/perf_ack ALERT_ID</code>");
      return true;
    }
    const alert = await acknowledgePerformanceAlert(id, `telegram:${chatId}`);
    await sendTelegramToChat(chatId, alert ? `✅ <b>Alert #${id} взято у роботу.</b> Повторна ескалація по ньому зупинена.` : `ℹ️ Alert #${id} не знайдений або для нього не потрібне підтвердження.`);
    return true;
  }

  const noteArg = commandArgument(text, "perf_note");
  if (noteArg !== null) {
    const match = /^(\d+)\s+(.+)$/.exec(noteArg);
    if (!match) {
      await sendTelegramToChat(chatId, "❌ Формат: <code>/perf_note ALERT_ID що саме зробили</code>");
      return true;
    }
    const id = Number(match[1]);
    const note = match[2].trim();
    const alert = await addPerformanceAlertNote(id, `telegram:${chatId}`, note);
    await sendTelegramToChat(chatId, alert ? `📝 <b>Нотатку до Alert #${id} збережено.</b>\n${escapeTelegramHtml(note)}` : `❌ Alert #${id} не знайдений.`);
    return true;
  }

  const doneArg = commandArgument(text, "perf_done");
  if (doneArg !== null) {
    const id = Number(doneArg);
    if (!Number.isInteger(id) || id <= 0) {
      await sendTelegramToChat(chatId, "❌ Формат: <code>/perf_done ALERT_ID</code>");
      return true;
    }
    const alert = await resolvePerformanceAlert(id, `telegram:${chatId}`);
    await sendTelegramToChat(chatId, alert ? `🟢 <b>Alert #${id} закрито.</b>` : `❌ Alert #${id} не знайдений.`);
    return true;
  }

  const bindArg = commandArgument(text, "reporting") ?? commandArgument(text, "reporting_bind");
  if (bindArg !== null) {
    if (!bindArg) {
      await sendTelegramToChat(chatId, "📊 Для підключення звітності використайте команду, яку надав ваш менеджер PTS.");
      return true;
    }
    const config = await resolveConfiguredAccount(bindArg);
    if (!config) {
      await sendTelegramToChat(chatId, "❌ Не вдалося підключити звітність. Зверніться до менеджера PTS.");
      return true;
    }
    await upsertReportingTelegramSubscription({ telegram_chat_id: chatId, meta_account_id: config.meta_account_id, account_name: config.project_name });
    await sendTelegramToChat(
      chatId,
      `✅ <b>PTS Reporting підключено</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\n\nЩоранку звіт автоматично оновлюється даними за попередній день.\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`,
    );
    return true;
  }

  if (text === "/reporting_status" || text.startsWith("/reporting_status@")) {
    const subscriptions = await listReportingTelegramSubscriptions(chatId);
    if (!subscriptions.length) {
      await sendTelegramToChat(chatId, "ℹ️ PTS Reporting для цієї групи ще не підключено.");
      return true;
    }
    const rows = subscriptions.map((row) => `• <b>${escapeTelegramHtml(row.account_name)}</b>`);
    await sendTelegramToChat(chatId, `📊 <b>Підключена звітність</b>\n\n${rows.join("\n")}`);
    return true;
  }

  const offArg = commandArgument(text, "reporting_off") ?? commandArgument(text, "reporting_unbind");
  if (offArg !== null) {
    if (offArg) {
      const accountId = normalizeAccountId(offArg);
      await disableReportingTelegramSubscription(chatId, accountId.startsWith("act_") ? accountId : `act_${accountId}`);
      await disableReportingTelegramSubscription(chatId, accountId);
    } else {
      await disableReportingTelegramSubscription(chatId);
    }
    await sendTelegramToChat(chatId, "⏹ <b>PTS Reporting notifications вимкнено.</b>");
    return true;
  }

  const nowArg = commandArgument(text, "reporting_now");
  if (nowArg !== null) {
    const subscriptions = await listReportingTelegramSubscriptions(chatId);
    let targets = subscriptions;
    if (nowArg) {
      const normalized = normalizeAccountId(nowArg);
      targets = subscriptions.filter((row) => normalizeAccountId(row.meta_account_id) === normalized);
    }
    if (!targets.length) {
      await sendTelegramToChat(chatId, "❌ Для цього проєкту звітність у цій групі не підключена.");
      return true;
    }
    const date = yesterdayKyivIso();
    for (const target of targets) {
      const config = await getReportingConfig(target.meta_account_id);
      if (!config) continue;
      await ensureProjectReportLifecycle({ spreadsheetId: config.report_file_id, projectName: config.project_name, goalKey: config.goal_key, goalLabel: config.goal_label, reportingStartDate: config.report_start_date });
      const result = await syncMetaReporting({ accountId: config.meta_account_id, spreadsheetId: config.report_file_id, since: date, until: date });
      await sendTelegramToChat(
        chatId,
        `✅ <b>Звіт оновлено за ${uaDate(date)}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nРезультати: <b>${result.mappedLeads}</b>\nВитрати: <b>$${result.mappedSpend.toFixed(2)}</b>\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`,
      );
    }
    return true;
  }

  return false;
}
