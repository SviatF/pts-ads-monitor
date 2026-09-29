import { NextRequest, NextResponse } from "next/server";
import { hasDeliveredInvoice, listInvoiceSubscriptions, rememberDeliveredInvoice } from "@/lib/invoice-store";
import { escapeTelegramHtml, sendInvoicePdfToChat } from "@/lib/invoice-telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: NextRequest) {
  const secret = process.env.INVOICE_RUNNER_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const accountId = String(form.get("meta_account_id") || "").replace(/^act_/, "").trim();
  const invoiceKey = String(form.get("invoice_key") || "").trim();
  const invoiceDate = String(form.get("invoice_date") || "").trim() || null;
  const amountRaw = String(form.get("amount") || "").trim();
  const currency = String(form.get("currency") || "").trim() || null;
  const sourceUrl = String(form.get("source_url") || "").trim() || null;
  const file = form.get("pdf");

  if (!accountId || !invoiceKey || !(file instanceof File)) {
    return NextResponse.json({ error: "meta_account_id, invoice_key and pdf are required" }, { status: 400 });
  }
  if (!/^\d{5,25}$/.test(accountId)) {
    return NextResponse.json({ error: "Invalid Meta ad account ID" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(invoiceKey)) {
    return NextResponse.json({ error: "Invalid invoice key" }, { status: 400 });
  }
  if (invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    return NextResponse.json({ error: "invoice_date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "PDF is too large" }, { status: 413 });
  }
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 415 });
  }

  const subscriptions = (await listInvoiceSubscriptions()).filter((s) => s.meta_account_id === accountId);
  const eligible = subscriptions.filter((s) => !invoiceDate || invoiceDate >= s.start_date);
  const delivered: string[] = [];
  const skipped: string[] = [];

  for (const subscription of eligible) {
    const alreadyDelivered = await hasDeliveredInvoice(subscription.telegram_chat_id, accountId, invoiceKey);
    if (alreadyDelivered) {
      skipped.push(subscription.telegram_chat_id);
      continue;
    }

    const amount = amountRaw ? Number(amountRaw) : null;
    const amountText = Number.isFinite(amount) && amount !== null
      ? `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}${currency ? ` ${escapeTelegramHtml(currency)}` : ""}`
      : currency ? escapeTelegramHtml(currency) : "—";
    const safeName = escapeTelegramHtml(subscription.account_name);
    const safeAccountId = escapeTelegramHtml(accountId);
    const safeInvoiceKey = escapeTelegramHtml(invoiceKey);
    const safeDate = invoiceDate ? escapeTelegramHtml(invoiceDate) : null;
    const caption = `🧾 <b>NEW META INVOICE</b>\n\nAccount: <b>${safeName}</b>\nID: <code>${safeAccountId}</code>\nInvoice: <code>${safeInvoiceKey}</code>${safeDate ? `\nDate: <b>${safeDate}</b>` : ""}\nAmount: <b>${amountText}</b>\n\n✅ Original Meta PDF`;

    const sent = await sendInvoicePdfToChat({
      chatId: subscription.telegram_chat_id,
      fileName: file.name || `Meta_Invoice_${invoiceKey}.pdf`,
      pdf: file,
      caption,
    });

    await rememberDeliveredInvoice({
      telegram_chat_id: subscription.telegram_chat_id,
      meta_account_id: accountId,
      invoice_key: invoiceKey,
      invoice_date: invoiceDate,
      amount: Number.isFinite(amount) ? amount : null,
      currency,
      file_name: file.name || `Meta_Invoice_${invoiceKey}.pdf`,
      source_url: sourceUrl,
      telegram_message_id: sent?.message_id != null ? String(sent.message_id) : null,
    });
    delivered.push(subscription.telegram_chat_id);
  }

  return NextResponse.json({ ok: true, accountId, invoiceKey, delivered, skipped });
}
