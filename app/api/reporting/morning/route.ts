import { NextResponse } from "next/server";
import { listReportingConfigs } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import { listReportingTelegramSubscriptionsForAccount } from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function kyivDateIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDay(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function uaDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

async function notify(chatId: string, text: string) {
  try {
    await sendTelegramToChat(chatId, text);
  } catch (error) {
    console.error("Telegram reporting notification failed", chatId, error);
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const today = kyivDateIso();
  const date = previousDay(today);
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  const configs = (await listReportingConfigs()).filter((item) => item.status === "configured");
  const results: Array<Record<string, unknown>> = [];

  for (const config of configs) {
    try {
      const lifecycle = await ensureProjectReportLifecycle({
        spreadsheetId: config.report_file_id,
        projectName: config.project_name,
        goalKey: config.goal_key,
        goalLabel: config.goal_label,
        reportingStartDate: config.report_start_date,
      });

      const sync = await syncMetaReporting({
        accountId: config.meta_account_id,
        spreadsheetId: config.report_file_id,
        since: date,
        until: date,
      });

      const subscriptions = await listReportingTelegramSubscriptionsForAccount(config.meta_account_id);
      const createdText = lifecycle.created.length
        ? `\nНові аркуші: <b>${escapeTelegramHtml(lifecycle.created.join(", "))}</b>`
        : "";
      const message = `✅ <b>Звіт заповнено за ${uaDate(date)}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКабінет: <code>${escapeTelegramHtml(config.meta_account_id)}</code>\nРезультати: <b>${sync.mappedLeads}</b>\nSpend: <b>$${sync.mappedSpend.toFixed(2)}</b>${createdText}\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`;

      for (const subscription of subscriptions) await notify(subscription.telegram_chat_id, message);

      if (adminChatId && lifecycle.created.length) {
        await notify(
          adminChatId,
          `📊 <b>PTS Reporting · створено новий аркуш</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\n${escapeTelegramHtml(lifecycle.created.join("\n"))}\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`,
        );
      }

      results.push({
        accountId: config.meta_account_id,
        project: config.project_name,
        date,
        created: lifecycle.created,
        leads: sync.mappedLeads,
        spend: sync.mappedSpend,
        chatsNotified: subscriptions.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ accountId: config.meta_account_id, project: config.project_name, date, error: message });
      if (adminChatId) {
        await notify(adminChatId, `❌ <b>PTS Reporting morning sync failed</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\n<code>${escapeTelegramHtml(message)}</code>`);
      }
    }
  }

  return NextResponse.json({ ok: true, date, projects: results.length, results });
}
