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

async function alertSeverity(alertId: number) {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  try {
    const response = await fetch(`${cfg.url}/rest/v1/performance_alerts?id=eq.${alertId}&select=severity&limit=1`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const rows = await response.json() as Array<{ severity?: string }>;
    return rows[0]?.severity || null;
  } catch {
    return null;
  }
}

function stripAckLine(message: string) {
  return message
    .replace(/\nПідтвердити:\s*<code>\/perf_ack\s+\d+<\/code>/gi, "")
    .replace(/\nПідтвердьте:[^\n]*<code>\/perf_ack\s+\d+<\/code>[^\n]*/gi, "");
}

function isSuppressedPerformanceMessage(message: string) {
  return /CAMPAIGN WASTE|Campaign потребує оптимізації/i.test(message);
}

export async function sendPerformanceMessage(message: string) {
  const chatId = performanceChatId();
  if (!chatId) throw new Error("PERFORMANCE_TELEGRAM_CHAT_ID is not configured");

  // Campaign-level CPL comparison is intentionally disabled: campaigns can target
  // different funnels/audiences and are not directly comparable enough for a reliable alert.
  if (isSuppressedPerformanceMessage(message)) return 0;

  const alertId = alertIdFromMessage(message);
  if (alertId) {
    const severity = await alertSeverity(alertId);
    const requiresAck = severity === "action_required" || severity === "critical";
    if (!requiresAck) message = stripAckLine(message);
  }

  await sendTelegramToChat(chatId, message);
  return 1;
}
