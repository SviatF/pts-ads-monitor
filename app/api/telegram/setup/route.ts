import { NextRequest, NextResponse } from "next/server";

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

export async function POST(request: NextRequest) {
  try {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const webhookUrl = `${request.nextUrl.origin}/api/telegram`;
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || runnerSecret();

    const response = await fetch(`https://api.telegram.org/bot${telegramToken()}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
      cache: "no-store",
    });

    const body = await response.json();
    if (!response.ok || !body?.ok) {
      return NextResponse.json({ error: body?.description || "Telegram setWebhook failed" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, webhook_url: webhookUrl, description: body.description || null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
