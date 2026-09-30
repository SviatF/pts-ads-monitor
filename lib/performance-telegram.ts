import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

export function performanceChatId() {
  return process.env.PERFORMANCE_TELEGRAM_CHAT_ID?.trim() || "";
}

export function performanceMention(username: string | null | undefined) {
  if (!username) return "";
  const clean = username.trim().replace(/^@/, "");
  return clean ? `@${escapeTelegramHtml(clean)}` : "";
}

export async function sendPerformanceMessage(message: string) {
  const chatId = performanceChatId();
  if (!chatId) throw new Error("PERFORMANCE_TELEGRAM_CHAT_ID is not configured");
  await sendTelegramToChat(chatId, message);
  return 1;
}
