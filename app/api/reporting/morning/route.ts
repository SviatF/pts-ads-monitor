import { NextResponse } from "next/server";
import { listReportingConfigs } from "@/lib/reporting-store";
import { ensureProjectReportLifecycle } from "@/lib/google-reporting";
import { syncMetaReporting } from "@/lib/meta-reporting-sync";
import { listReportingTelegramSubscriptionsForAccount } from "@/lib/reporting-telegram-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { applyReportCurrencyFormats, formatCurrencyAmount, normalizeReportingCurrency } from "@/lib/report-currency";

export const dynamic = "force-dynamic";

const PROJECT_PACING_MS = 6000;
const RATE_LIMIT_RETRY_MS = 65000;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isGoogleOAuthReconnectRequired(error: unknown) {
  return errorMessage(error).includes("GOOGLE_OAUTH_RECONNECT_REQUIRED");
}

function isGoogleSheetsRateLimit(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("google api failed (429)") ||
    message.includes("resource_exhausted") ||
    message.includes("rate_limit_exceeded") ||
    message.includes("read requests per minute per user") ||
    message.includes("quota exceeded for quota metric 'read requests'")
  );
}

async function withSheetsRateLimitRetry<T>(label: string, operation: () => Promise<T>) {
  try {
    return { value: await operation(), retried: false };
  } catch (error) {
    if (!isGoogleSheetsRateLimit(error)) throw error;

    console.warn(`[Reporting] Google Sheets quota reached for ${label}. Retrying in ${RATE_LIMIT_RETRY_MS / 1000}s.`);
    await sleep(RATE_LIMIT_RETRY_MS);
    return { value: await operation(), retried: true };
  }
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

function shiftDay(iso: string, delta: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function previousDay(iso: string) {
  return shiftDay(iso, -1);
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
  const unrecoveredQuotaProjects: string[] = [];
  let quotaRetries = 0;
  let oauthReconnectRequired = false;

  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];

    // Keep all reporting projects under the per-user Sheets read quota instead of
    // bursting several spreadsheets through the same service account in one minute.
    if (index > 0) await sleep(PROJECT_PACING_MS);

    try {
      const operation = await withSheetsRateLimitRetry(config.project_name, async () => {
        const lifecycle = await ensureProjectReportLifecycle({
          spreadsheetId: config.report_file_id,
          projectName: config.project_name,
          goalKey: config.goal_key,
          goalLabel: config.goal_label,
          reportingStartDate: config.report_start_date,
        });

        // Repair a rolling 16-day window on every morning sync. This covers the
        // current reporting period plus the previous one and automatically heals
        // days missed because of OAuth/API outages without touching manager cells.
        const repairSinceCandidate = shiftDay(date, -15);
        const repairSince = config.report_start_date > repairSinceCandidate
          ? config.report_start_date
          : repairSinceCandidate;

        if (lifecycle.created.length) {
          await applyReportCurrencyFormats(config.report_file_id, config.currency || "USD");
        }

        const sync = await syncMetaReporting({
          accountId: config.meta_account_id,
          spreadsheetId: config.report_file_id,
          since: repairSince,
          until: date,
          currency: config.currency || "USD",
        });

        return { lifecycle, sync, repairSince };

      });

      if (operation.retried) quotaRetries += 1;
      const { lifecycle, sync, repairSince } = operation.value;

      const subscriptions = await listReportingTelegramSubscriptionsForAccount(config.meta_account_id);
      const createdText = lifecycle.created.length
        ? `\nНові аркуші: <b>${escapeTelegramHtml(lifecycle.created.join(", "))}</b>`
        : "";
      const message = `✅ <b>Звіт заповнено за ${uaDate(date)}</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nКабінет: <code>${escapeTelegramHtml(config.meta_account_id)}</code>\nРезультати за день: <b>${sync.untilLeads}</b>\nSpend за день: <b>${formatCurrencyAmount(sync.untilSpend, config.currency || "USD")}</b>\nSelf-heal: <b>${uaDate(repairSince)}–${uaDate(date)}</b>${createdText}\n\n<a href="${escapeTelegramHtml(config.report_url)}">Відкрити Google Sheet</a>`;

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
        leads: sync.untilLeads,
        spend: sync.untilSpend,
        repairSince,
        currency: normalizeReportingCurrency(config.currency || "USD"),
        chatsNotified: subscriptions.length,
        quotaRetried: operation.retried,
      });
    } catch (error) {
      const message = errorMessage(error);
      const quotaError = isGoogleSheetsRateLimit(error);
      const oauthError = isGoogleOAuthReconnectRequired(error);
      results.push({ accountId: config.meta_account_id, project: config.project_name, date, error: message, quotaError, oauthError });

      if (oauthError) {
        oauthReconnectRequired = true;
        // One broken Google credential affects every reporting project. Stop here
        // instead of flooding Telegram with the same OAuth error per project.
        break;
      }

      if (quotaError) {
        unrecoveredQuotaProjects.push(config.project_name);
      } else if (adminChatId) {
        await notify(adminChatId, `❌ <b>PTS Reporting morning sync failed</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\n<code>${escapeTelegramHtml(message)}</code>`);
      }
    }
  }

  if (adminChatId && oauthReconnectRequired) {
    await notify(
      adminChatId,
      `🔐 <b>PTS Reporting · Google OAuth потрібно перепідключити</b>\n\nGoogle refresh token недійсний. Morning sync зупинено один раз для всіх проєктів, щоб не спамити однаковими помилками.\n\n<a href="https://pts-ads-monitor.oleg22777.workers.dev/api/google/oauth/start">Перепідключити Google →</a>\n\nПісля авторизації новий refresh token збережеться автоматично.`,
    );
  } else if (adminChatId && unrecoveredQuotaProjects.length) {
    await notify(
      adminChatId,
      `⚠️ <b>PTS Reporting · Google Sheets quota</b>\n\nПісля автоматичного retry не вдалося завершити: <b>${unrecoveredQuotaProjects.length}</b>\n${unrecoveredQuotaProjects.map((name) => `• ${escapeTelegramHtml(name)}`).join("\n")}\n\nСистема вже робить pacing між проєктами та автоматично чекає скидання minute quota перед повторною спробою.`,
    );
  } else if (adminChatId && quotaRetries > 0) {
    await notify(
      adminChatId,
      `✅ <b>PTS Reporting · quota auto-recovery</b>\n\nGoogle Sheets rate limit спрацював <b>${quotaRetries}</b> раз(и), але всі affected проєкти успішно дозаповнені після автоматичного retry.`,
    );
  }

  return NextResponse.json({
    ok: unrecoveredQuotaProjects.length === 0 && !oauthReconnectRequired,
    date,
    projects: results.length,
    quotaRetries,
    unrecoveredQuotaProjects: unrecoveredQuotaProjects.length,
    oauthReconnectRequired,
    results,
  });
}
