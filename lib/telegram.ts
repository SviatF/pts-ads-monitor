function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegram(message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram is not configured");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram sendMessage failed");
}

export function accountProblemMessage(input: {
  name: string;
  id: string;
  label: string;
  kind: string;
}) {
  const title = input.kind === "payment" ? "💳 META PAYMENT ALERT" : "🚨 META ACCOUNT ALERT";
  const reason = input.kind === "payment" ? "Billing/payment state detected" : "Account requires attention";
  return `${title}\n\n<b>${escapeHtml(input.name)}</b>\n<code>${escapeHtml(input.id)}</code>\n\nStatus: <b>${escapeHtml(input.label)}</b>\n${reason}`;
}

export function accountRestoredMessage(name: string, id: string) {
  return `🟢 META ACCOUNT RESTORED\n\n<b>${escapeHtml(name)}</b>\n<code>${escapeHtml(id)}</code>\n\nStatus: <b>ACTIVE</b>`;
}

export function rejectedAdsMessage(accountName: string, accountId: string, names: string[]) {
  const list = names.slice(0, 25).map((name) => `• <code>${escapeHtml(name)}</code>`).join("\n");
  const extra = names.length > 25 ? `\n…та ще ${names.length - 25}` : "";
  return `❌ META ADS REJECTED\n\n<b>${escapeHtml(accountName)}</b>\n<code>${escapeHtml(accountId)}</code>\n\n${list}${extra}`;
}
