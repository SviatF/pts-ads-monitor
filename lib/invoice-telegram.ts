function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

export function escapeTelegramHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegramToChat(chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram sendMessage failed");
  return body.result;
}

export async function sendInvoicePdfToChat(input: {
  chatId: string;
  fileName: string;
  pdf: Blob;
  caption: string;
}) {
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set("caption", input.caption);
  form.set("parse_mode", "HTML");
  form.set("document", input.pdf, input.fileName);

  const response = await fetch(`https://api.telegram.org/bot${botToken()}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram sendDocument failed");
  return body.result;
}
