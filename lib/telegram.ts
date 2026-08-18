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

function ukrainianStatus(label: string) {
  const labels: Record<string, string> = {
    ACTIVE: "Активний",
    DISABLED: "Рекламний кабінет вимкнено",
    UNSETTLED: "Проблема з оплатою / заборгованість",
    PENDING_SETTLEMENT: "Очікується оплата",
    IN_GRACE_PERIOD: "Пільговий період оплати",
    PENDING_RISK_REVIEW: "Очікується перевірка ризиків",
    PENDING_CLOSURE: "Очікує закриття",
    CLOSED: "Закритий",
  };
  return labels[label] || label;
}

export function newAccountAddedMessage(name: string, id: string) {
  return `🟢 НОВИЙ РЕКЛАМНИЙ КАБІНЕТ ДОДАНО НА МОНІТОРИНГ\n\n<b>${escapeHtml(name)}</b>\n<code>${escapeHtml(id)}</code>\n\nСистема автоматично відстежуватиме статус кабінету, проблеми з оплатою та відхилені оголошення.`;
}

export function accountProblemMessage(input: {
  name: string;
  id: string;
  label: string;
  kind: string;
}) {
  const isPayment = input.kind === "payment";
  const title = isPayment ? "💳 ПРОБЛЕМА З ОПЛАТОЮ РК" : "🚨 ПРОБЛЕМА З РЕКЛАМНИМ КАБІНЕТОМ";
  const status = ukrainianStatus(input.label);
  const hint = isPayment
    ? "Перевірте білінг, спосіб оплати та наявність заборгованості."
    : "Перевірте рекламний кабінет у Meta Business Manager.";

  return `${title}\n\n<b>${escapeHtml(input.name)}</b>\n<code>${escapeHtml(input.id)}</code>\n\nСтатус: <b>${escapeHtml(status)}</b>\n${hint}`;
}

export function accountRestoredMessage(name: string, id: string) {
  return `🟢 РЕКЛАМНИЙ КАБІНЕТ ВІДНОВЛЕНО\n\n<b>${escapeHtml(name)}</b>\n<code>${escapeHtml(id)}</code>\n\nСтатус: <b>Активний</b>`;
}

export function rejectedAdsMessage(accountName: string, accountId: string, names: string[]) {
  const list = names.slice(0, 25).map((name) => `• <code>${escapeHtml(name)}</code>`).join("\n");
  const extra = names.length > 25 ? `\n…та ще ${names.length - 25}` : "";
  return `❌ ВІДХИЛЕНО ОГОЛОШЕННЯ\n\nРекламний кабінет: <b>${escapeHtml(accountName)}</b>\n<code>${escapeHtml(accountId)}</code>\n\nВідхилені оголошення:\n${list}${extra}`;
}
