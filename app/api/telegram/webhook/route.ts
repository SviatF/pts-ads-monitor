import { NextRequest, NextResponse } from "next/server";
import { telegramWebhookSecret } from "@/lib/telegram-webhook-secret";
import { POST as handleTelegramPost } from "../route";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const safeSecret = telegramWebhookSecret();
  if (!safeSecret) return NextResponse.json({ error: "Webhook secret is not configured" }, { status: 500 });

  const supplied = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (supplied !== safeSecret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawSecret = process.env.TELEGRAM_WEBHOOK_SECRET || process.env.INVOICE_RUNNER_SECRET;
  if (!rawSecret) return NextResponse.json({ error: "Raw webhook secret is not configured" }, { status: 500 });

  const body = await request.text();
  const target = new URL("/api/telegram", request.url);
  const forwarded = new NextRequest(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": rawSecret,
    },
    body,
  });

  return handleTelegramPost(forwarded);
}
