import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

export function performanceChatId() {
  return process.env.PERFORMANCE_TELEGRAM_CHAT_ID?.trim() || "";
}

export function performanceMention(username: string | null | undefined) {
  if (!username) return "";
  const clean = username.trim().replace(/^@/, "");
  return clean ? `@${escapeTelegramHtml(clean)}` : "";
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function alertIdFromMessage(message: string) {
  const match = /Alert ID:\s*<code>(\d+)<\/code>/i.exec(message);
  return match ? Number(match[1]) : null;
}

async function alertMeta(alertId: number) {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  try {
    const response = await fetch(`${cfg.url}/rest/v1/performance_alerts?id=eq.${alertId}&select=severity,alert_type&limit=1`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const rows = await response.json() as Array<{ severity?: string; alert_type?: string }>;
    return rows[0] || null;
  } catch {
    return null;
  }
}

function stripAckLine(message: string) {
  return message
    .replace(/\nПідтвердити:\s*<code>\/perf_ack\s+\d+<\/code>/gi, "")
    .replace(/\nПідтвердьте:[^\n]*<code>\/perf_ack\s+\d+<\/code>[^\n]*/gi, "");
}

const DISABLED_ALERT_TYPES = new Set(["CAMPAIGN_WASTE", "A_LEAD_DROP"]);

function isSuppressedPerformanceMessage(message: string) {
  return /CAMPAIGN WASTE|Campaign потребує оптимізації|A-LEAD RATE ПРОСІВ/i.test(message);
}

export async function sendPerformanceMessage(message: string) {
  const chatId = performanceChatId();
  if (!chatId) throw new Error("PERFORMANCE_TELEGRAM_CHAT_ID is not configured");

  // These alerts are intentionally disabled because their comparison can be misleading
  // without enough business context. Keep them out of the team chat even if legacy code creates one.
  if (isSuppressedPerformanceMessage(message)) return 0;

  const alertId = alertIdFromMessage(message);
  if (alertId) {
    const meta = await alertMeta(alertId);
    if (meta?.alert_type && DISABLED_ALERT_TYPES.has(meta.alert_type)) return 0;
    const requiresAck = meta?.severity === "action_required" || meta?.severity === "critical";
    if (!requiresAck) message = stripAckLine(message);
  }

  await sendTelegramToChat(chatId, message);
  return 1;
}
