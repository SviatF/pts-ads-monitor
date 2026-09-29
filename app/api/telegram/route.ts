import { NextRequest, NextResponse } from "next/server";
import { getBusinessAccounts } from "@/lib/meta";
import {
  clearInvoiceSetupSession,
  disableInvoiceSubscriptions,
  getInvoiceSetupSession,
  listInvoiceSubscriptions,
  setInvoiceSetupSession,
  upsertInvoiceSubscription,
} from "@/lib/invoice-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

export const dynamic = "force-dynamic";

function webhookAuthorized(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
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

export async function POST(request: NextRequest) {
  if (!webhookAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const update = await request.json();
  const message = update?.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!chatId || !text) return NextResponse.json({ ok: true });

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
