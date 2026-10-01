import { NextRequest, NextResponse } from "next/server";
import { auditPerformanceAccount } from "@/lib/performance-account-audit";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";
import { telegramWebhookSecret } from "@/lib/telegram-webhook-secret";

export const dynamic = "force-dynamic";

function webhookAuthorized(request: NextRequest) {
  const secret = telegramWebhookSecret();
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("x-telegram-bot-api-secret-token") === secret;
}

function commandArgument(text: string) {
  const match = /^\/(?:audit_account|performance_account)(?:@\w+)?(?:\s+(.+))?$/i.exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}

export async function POST(request: NextRequest) {
  if (!webhookAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const update = await request.json();
  const message = update?.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!chatId || !text) return NextResponse.json({ ok: true });

  const arg = commandArgument(text);
  if (arg === null) return NextResponse.json({ ok: true, ignored: true });
  const normalized = arg.replace(/[<>]/g, "").replace(/^act_/i, "").trim();
  if (!/^\d{5,25}$/.test(normalized)) {
    await sendTelegramToChat(chatId, "❌ Формат: <code>/audit_account 123456789012345</code>");
    return NextResponse.json({ ok: true });
  }

  await sendTelegramToChat(chatId, `⏳ <b>Запускаю повний аудит одного кабінету...</b>\n<code>act_${escapeTelegramHtml(normalized)}</code>\n\nMeta + performance logic + raw actions + reporting + open alerts.`);
  try {
    const result = await auditPerformanceAccount(normalized);
    for (const part of result.messages) await sendTelegramToChat(chatId, part);
  } catch (error) {
    await sendTelegramToChat(chatId, `❌ Account audit failed: <code>${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}</code>`);
  }

  return NextResponse.json({ ok: true });
}
