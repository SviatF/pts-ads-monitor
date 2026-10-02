import { NextRequest, NextResponse } from "next/server";
import { tasksBotApi, tasksBotWebhookSecret } from "@/lib/tasks-bot-telegram";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const webhookUrl = `${request.nextUrl.origin}/api/tasks-bot`;
    await tasksBotApi("setWebhook", {
      url: webhookUrl,
      secret_token: tasksBotWebhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });

    const info = await tasksBotApi<Record<string, unknown>>("getWebhookInfo");
    const me = await tasksBotApi<Record<string, unknown>>("getMe");

    return NextResponse.json({
      ok: true,
      webhook_url: webhookUrl,
      bot: me,
      webhook_info: info,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
