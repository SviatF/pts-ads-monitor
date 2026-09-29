import { NextRequest, NextResponse } from "next/server";
import { getAdAccountBillingDiagnostics, getBusinessAccounts, getBusinessInvoices } from "@/lib/meta";
import {
  clearInvoiceSetupSession,
  disableInvoiceSubscriptions,
  getInvoiceSetupSession,
  listInvoiceSubscriptions,
  setInvoiceSetupSession,
  upsertInvoiceSubscription,
} from "@/lib/invoice-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { handleReportingTelegramCommand } from "@/lib/reporting-telegram";
import { telegramWebhookSecret } from "@/lib/telegram-webhook-secret";

export const dynamic = "force-dynamic";

function webhookAuthorized(request: NextRequest) {
  const secret = telegramWebhookSecret();
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("x-telegram-bot-api-secret-token") === secret;
}

function normalizeAccountId(value: string) {
  return value.trim().replace(/^act_/, "");
}

function parseDate(value: string) {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ua = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (ua) return `${ua[3]}-${ua[2]}-${ua[1]}`;
  return null;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function commandArgument(text: string, command: string) {
  const pattern = new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(.+))?$`, "i");
  const match = pattern.exec(text);
  return match ? (match[1] || "").trim() : null;
}

export async function POST(request: NextRequest) {
  if (!webhookAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const update = await request.json();
  const message = update?.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!chatId || !text) return NextResponse.json({ ok: true });

  if (await handleReportingTelegramCommand(chatId, text)) {
    return NextResponse.json({ ok: true });
  }

  const paymentTestArg = commandArgument(text, "payment_api_test");
  if (paymentTestArg !== null) {
    const accountId = normalizeAccountId(paymentTestArg.replace(/[<>]/g, ""));
    if (!/^\d{5,25}$/.test(accountId)) {
      await sendTelegramToChat(chatId, "❌ Формат: <code>/payment_api_test 123456789012345</code>");
      return NextResponse.json({ ok: true });
    }

    try {
      const result = await getAdAccountBillingDiagnostics(accountId);
      const account = result.account as Record<string, unknown>;
      const probeRows = result.probes.map((probe) => {
        if (probe.result.ok) {
          const data = Array.isArray((probe.result.body as { data?: unknown[] })?.data)
            ? (probe.result.body as { data?: unknown[] }).data || []
            : [];
          return `• <code>/${escapeTelegramHtml(probe.edge)}</code>: ✅ endpoint відповів, rows=<b>${data.length}</b>`;
        }
        return `• <code>/${escapeTelegramHtml(probe.edge)}</code>: ❌ ${escapeTelegramHtml(probe.result.error)}${probe.result.code != null ? ` (code ${probe.result.code})` : ""}`;
      }).join("\n");

      const hasUsablePaymentEdge = result.probes.some((probe) => probe.result.ok);
      const verdict = hasUsablePaymentEdge
        ? "🟡 Один із billing edge відповів. Далі дивимось, чи є там receipt/PDF fields."
        : "⚠️ Для цього ad account публічний Marketing API не віддав payment/receipt edge. Для звичайних card/threshold charges PDF, найімовірніше, доведеться брати через Billing UI.";

      await sendTelegramToChat(
        chatId,
        `🧪 <b>META PAYMENT API TEST</b>\n\nAccount: <b>${escapeTelegramHtml(String(account.name || "—"))}</b>\nID: <code>${escapeTelegramHtml(String(account.id || `act_${accountId}`))}</code>\nGraph: <code>${escapeTelegramHtml(result.graphVersion)}</code>\nCurrency: <b>${escapeTelegramHtml(String(account.currency || "—"))}</b>\nBalance: <b>${escapeTelegramHtml(String(account.balance ?? "—"))}</b>\nAmount spent: <b>${escapeTelegramHtml(String(account.amount_spent ?? "—"))}</b>\n\n<b>Billing edge probes:</b>\n${probeRows}\n\n${verdict}`
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendTelegramToChat(chatId, `❌ <b>META PAYMENT API TEST FAILED</b>\n\n<code>${escapeTelegramHtml(messageText)}</code>`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/invoice_api_test" || text.startsWith("/invoice_api_test@")) {
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 180);

    try {
      const result = await getBusinessInvoices({ startDate: isoDate(start), endDate: isoDate(end) });
      const invoices = result.invoices;
      const pdfCount = invoices.filter((invoice) => Boolean(invoice.download_uri || invoice.cdn_download_uri)).length;
      const sample = invoices
        .slice(0, 5)
        .map((invoice) => {
          const id = invoice.invoice_id || invoice.id || "—";
          const date = invoice.invoice_date || invoice.billing_period || "—";
          const amount = invoice.billed_amount_details?.total_amount ?? invoice.amount_due ?? "—";
          const currency = invoice.billed_amount_details?.currency || "";
          const pdf = invoice.download_uri || invoice.cdn_download_uri ? "✅ PDF" : "⚪ без PDF URL";
          return `• <code>${escapeTelegramHtml(String(id))}</code> · ${escapeTelegramHtml(String(date))} · <b>${escapeTelegramHtml(String(amount))}${currency ? ` ${escapeTelegramHtml(currency)}` : ""}</b> · ${pdf}`;
        })
        .join("\n");

      const verdict = invoices.length === 0
        ? "⚠️ Meta API доступний, але за останні 180 днів invoices не повернув. Це часто означає, що бізнес не використовує month-end invoicing / credit line для цих оплат."
        : pdfCount > 0
          ? "✅ <b>УСПІХ: Meta API повертає invoice PDF URL.</b> Browser automation нам не потрібен."
          : "🟡 Invoices повертаються, але PDF URL у відповіді немає. Треба перевірити доступні поля/роль finance.";

      await sendTelegramToChat(
        chatId,
        `🧪 <b>META INVOICE API TEST</b>\n\nBusiness: <code>${escapeTelegramHtml(result.businessId)}</code>\nGraph: <code>${escapeTelegramHtml(result.graphVersion)}</code>\nPeriod: ${isoDate(start)} → ${isoDate(end)}\nInvoices: <b>${invoices.length}</b>\nWith PDF URL: <b>${pdfCount}</b>\n\n${verdict}${sample ? `\n\n<b>Перші результати:</b>\n${sample}` : ""}`
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await sendTelegramToChat(
        chatId,
        `❌ <b>META INVOICE API TEST FAILED</b>\n\n<code>${escapeTelegramHtml(messageText)}</code>\n\nЦе дасть нам точну причину: permission/finance role/endpoint/тип billing.`
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/start_invoices" || text.startsWith("/start_invoices@")) {
    await setInvoiceSetupSession({
      telegram_chat_id: chatId,
      step: "awaiting_account_id",
      updated_at: new Date().toISOString(),
    });
    await sendTelegramToChat(chatId, "🧾 <b>Meta Invoice Monitor</b>\n\nНадішліть ID рекламного кабінету.\nПриклад: <code>123456789012345</code> або <code>act_123456789012345</code>.");
    return NextResponse.json({ ok: true });
  }

  if (text === "/stop_invoices" || text.startsWith("/stop_invoices@")) {
    await clearInvoiceSetupSession(chatId);
    await disableInvoiceSubscriptions(chatId);
    await sendTelegramToChat(chatId, "⏹ <b>Invoice Monitor вимкнено</b> для цієї Telegram-групи.");
    return NextResponse.json({ ok: true });
  }

  if (text === "/invoice_status" || text.startsWith("/invoice_status@")) {
    const subscriptions = await listInvoiceSubscriptions(chatId);
    if (!subscriptions.length) {
      await sendTelegramToChat(chatId, "ℹ️ У цій групі немає активних invoice subscriptions.\n\nДля підключення: /start_invoices");
      return NextResponse.json({ ok: true });
    }
    const rows = subscriptions
      .map((s) => `• <b>${escapeTelegramHtml(s.account_name)}</b> — <code>${escapeTelegramHtml(s.meta_account_id)}</code>\n  з ${escapeTelegramHtml(s.start_date)}`)
      .join("\n");
    await sendTelegramToChat(chatId, `🧾 <b>Invoice Monitor активний</b>\n\n${rows}`);
    return NextResponse.json({ ok: true });
  }

  const session = await getInvoiceSetupSession(chatId);
  if (!session) return NextResponse.json({ ok: true });

  if (session.step === "awaiting_account_id") {
    const accountId = normalizeAccountId(text);
    if (!/^\d{5,25}$/.test(accountId)) {
      await sendTelegramToChat(chatId, "❌ Не схоже на Meta Ad Account ID. Надішліть лише ID кабінету.");
      return NextResponse.json({ ok: true });
    }

    const accounts = await getBusinessAccounts();
    const account = accounts.find((item) => normalizeAccountId(item.id) === accountId);
    if (!account) {
      await sendTelegramToChat(chatId, `❌ Кабінет <code>${escapeTelegramHtml(accountId)}</code> не знайдений серед доступних цьому monitor-у Meta accounts.`);
      return NextResponse.json({ ok: true });
    }

    await setInvoiceSetupSession({
      telegram_chat_id: chatId,
      step: "awaiting_start_date",
      meta_account_id: accountId,
      account_name: account.name,
      currency: account.currency || null,
      updated_at: new Date().toISOString(),
    });

    await sendTelegramToChat(
      chatId,
      `✅ Кабінет знайдено\n\n<b>${escapeTelegramHtml(account.name)}</b>\n<code>${escapeTelegramHtml(accountId)}</code>${account.currency ? `\nCurrency: <b>${escapeTelegramHtml(account.currency)}</b>` : ""}\n\n📅 З якої дати почати витягувати інвойси?\nНаприклад: <code>01.09.2026</code>`
    );
    return NextResponse.json({ ok: true });
  }

  const startDate = parseDate(text);
  if (!startDate || !session.meta_account_id || !session.account_name) {
    await sendTelegramToChat(chatId, "❌ Невірний формат дати. Використайте <code>DD.MM.YYYY</code>, наприклад <code>01.09.2026</code>.");
    return NextResponse.json({ ok: true });
  }

  await upsertInvoiceSubscription({
    telegram_chat_id: chatId,
    meta_account_id: session.meta_account_id,
    account_name: session.account_name,
    currency: session.currency || null,
    start_date: startDate,
    enabled: true,
  });
  await clearInvoiceSetupSession(chatId);

  await sendTelegramToChat(
    chatId,
    `✅ <b>Invoice Monitor activated</b>\n\nAccount: <b>${escapeTelegramHtml(session.account_name)}</b>\nID: <code>${escapeTelegramHtml(session.meta_account_id)}</code>\nStart date: <b>${escapeTelegramHtml(startDate)}</b>\n\nНові PDF-інвойси для цього кабінету будуть надсилатися саме в цю групу.`
  );

  return NextResponse.json({ ok: true });
}
