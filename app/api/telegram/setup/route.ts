import { NextRequest, NextResponse } from "next/server";
import { telegramWebhookSecret } from "@/lib/telegram-webhook-secret";

export const dynamic = "force-dynamic";

function runnerSecret() {
  const value = process.env.INVOICE_RUNNER_SECRET;
  if (!value) throw new Error("INVOICE_RUNNER_SECRET is not configured");
  return value;
}

function telegramToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return value;
}

function authorized(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${runnerSecret()}`;
}

async function configureWebhook(request: NextRequest) {
  const webhookUrl = `${request.nextUrl.origin}/api/telegram`;
  const secretToken = telegramWebhookSecret();
  if (!secretToken) throw new Error("TELEGRAM_WEBHOOK_SECRET or INVOICE_RUNNER_SECRET is not configured");

  const setResponse = await fetch(`https://api.telegram.org/bot${telegramToken()}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
    cache: "no-store",
  });
  const setBody = await setResponse.json();
  if (!setResponse.ok || !setBody?.ok) {
    return NextResponse.json({ error: setBody?.description || "Telegram setWebhook failed" }, { status: 502 });
  }

  const infoResponse = await fetch(`https://api.telegram.org/bot${telegramToken()}/getWebhookInfo`, {
    cache: "no-store",
  });
  const infoBody = await infoResponse.json();

  return NextResponse.json({
    ok: true,
    webhook_url: webhookUrl,
    description: setBody.description || null,
    webhook_info: infoBody?.result
      ? {
          url: infoBody.result.url,
          pending_update_count: infoBody.result.pending_update_count,
          last_error_date: infoBody.result.last_error_date || null,
          last_error_message: infoBody.result.last_error_message || null,
          allowed_updates: infoBody.result.allowed_updates || [],
        }
      : null,
  });
}

// Browser-friendly setup route. Access is protected by the dashboard Basic Auth middleware.
export async function GET(request: NextRequest) {
  try {
    return await configureWebhook(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return await configureWebhook(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
