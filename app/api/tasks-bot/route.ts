import { NextRequest, NextResponse } from "next/server";
import { handleTasksBotUpdate, type TasksBotUpdate } from "@/lib/tasks-bot-handler";
import { tasksBotWebhookSecret } from "@/lib/tasks-bot-telegram";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const supplied = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (supplied !== tasksBotWebhookSecret()) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const update = await request.json() as TasksBotUpdate;
    await handleTasksBotUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Tasks bot webhook failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
