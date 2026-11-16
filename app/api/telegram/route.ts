import { NextRequest, NextResponse } from "next/server";
import { handleReportingTelegramCommand } from "@/lib/reporting-telegram";
import { telegramWebhookSecret } from "@/lib/telegram-webhook-secret";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = telegramWebhookSecret();
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const update = await request.json();
  const message = update?.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (chatId && text) await handleReportingTelegramCommand(chatId, text);
  return NextResponse.json({ ok: true });
}
