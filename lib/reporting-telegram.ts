import { getReportingConfig } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import {
  disableReportingTelegramSubscription,
  listReportingTelegramSubscriptions,
  upsertReportingTelegramSubscription,
} from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

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
  const bindArg = commandArgument(text, "reporting") ?? commandArgument(text, "reporting_bind");
  if (bindArg !== null) {
    if (!bindArg) {
      await sendTelegramToChat(chatId, "📊 Формат: <code>/reporting 123456789012345</code>\nабо <code>/reporting_bind act_123456789012345</code>");
      return true;
    }
    const config = await resolveConfiguredAccount(bindArg);
    if (!config) {
      await sendTelegramToChat(chatId, "❌ Не знайшов налаштовану звітність для цього Meta cabinet ID. Спочатку створіть Google звіт у Ads Monitor.");
      return true;
    }
    await upsertReportingTelegramSubscription({ telegram_chat_id: chatId, meta_account_id: config.meta_account_id, account_name: config.project_name });
    await sendTelegramToChat(
      chatId,
      `✅ <b>PTS Reporting + Performance Control підключено до цієї групи</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКабінет: <code>${escapeTelegramHtml(config.meta_account_id)}</code>${config.targetologist_telegram ? `\nТаргетолог: <b>${escapeTelegramHtml(config.targetologist_telegram)}</b>` : "\n⚠️ Таргетолог ще не вказаний у налаштуваннях проєкту."}\n\nЩоранку о <b>07:00 Europe/Kyiv</b> бот синхронізує попередній день. Окремо Performance Control перевіряє кабінет протягом дня й пушить сюди optimization alerts.\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`,
    );
    return true;
  }

  if (text === "/reporting_status" || text.startsWith("/reporting_status@")) {
    const subscriptions = await listReportingTelegramSubscriptions(chatId);
    if (!subscriptions.length) {
      await sendTelegramToChat(chatId, "ℹ️ У цій групі reporting ще не підключено.\n\nКоманда: <code>/reporting META_ACCOUNT_ID</code>");
      return true;
    }
    const rows: string[] = [];
    for (const row of subscriptions) {
      const config = await getReportingConfig(row.meta_account_id);
      rows.push(`• <b>${escapeTelegramHtml(row.account_name)}</b> — <code>${escapeTelegramHtml(row.meta_account_id)}</code>${config?.targetologist_telegram ? ` — ${escapeTelegramHtml(config.targetologist_telegram)}` : ""}`);
    }
    await sendTelegramToChat(chatId, `📊 <b>Reporting + Performance subscriptions</b>\n\n${rows.join("\n")}`);
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
    await sendTelegramToChat(chatId, "⏹ <b>Reporting + Performance notifications вимкнено</b> для вибраного кабінету/цієї групи.");
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
      await sendTelegramToChat(chatId, "❌ Для цього кабінету немає reporting subscription у цій групі.");
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
        `✅ <b>Звіт заповнено за ${uaDate(date)}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>${config.targetologist_telegram ? `\nТаргетолог: <b>${escapeTelegramHtml(config.targetologist_telegram)}</b>` : ""}\nРезультати: <b>${result.mappedLeads}</b>\nSpend: <b>$${result.mappedSpend.toFixed(2)}</b>\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`,
      );
    }
    return true;
  }

  return false;
}
