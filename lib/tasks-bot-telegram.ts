import { escapeTelegramHtml } from "@/lib/invoice-telegram";

export type TasksBotInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TasksBotReplyMarkup =
  | { inline_keyboard: TasksBotInlineButton[][] }
  | { keyboard: Array<Array<{ text: string }>>; resize_keyboard?: boolean; one_time_keyboard?: boolean }
  | { remove_keyboard: boolean };

function tasksBotToken() {
  const token = process.env.TASKS_BOT_FOR_MAIN?.trim();
  if (!token) throw new Error("TASKS_BOT_FOR_MAIN is not configured");
  return token;
}

export function tasksBotWebhookSecret() {
  const raw = (process.env.TASKS_BOT_WEBHOOK_SECRET || process.env.CRON_SECRET || "").trim();
  if (!raw) throw new Error("TASKS_BOT_WEBHOOK_SECRET or CRON_SECRET is not configured");
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
  if (!safe) throw new Error("Tasks bot webhook secret is empty");
  return safe;
}

export async function tasksBotApi<T = unknown>(method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`https://api.telegram.org/bot${tasksBotToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await response.json() as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram ${method} failed`);
  return body.result as T;
}

export async function sendTasksBotMessage(input: {
  chatId: string | number;
  text: string;
  replyMarkup?: TasksBotReplyMarkup;
}) {
  return tasksBotApi("sendMessage", {
    chat_id: input.chatId,
    text: input.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  });
}

export async function answerTasksBotCallback(callbackQueryId: string, text = "") {
  return tasksBotApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

export const tasksBotMainKeyboard: TasksBotReplyMarkup = {
  keyboard: [
    [{ text: "➕ Додати задачу" }, { text: "👥 Поставити задачу" }],
    [{ text: "📋 Активні задачі" }, { text: "🔥 На сьогодні" }],
    [{ text: "👔 Від керівника" }, { text: "🤝 Від команди" }],
    [{ text: "⏰ Прострочені" }, { text: "✅ Виконані" }],
    [{ text: "⚙️ Налаштування" }],
  ],
  resize_keyboard: true,
};

export function priorityLabel(priority: string) {
  if (priority === "high") return "🔴 Високий";
  if (priority === "low") return "⚪ Низький";
  return "🟡 Звичайний";
}

export function priorityIcon(priority: string) {
  if (priority === "high") return "🔴";
  if (priority === "low") return "⚪";
  return "🟡";
}

export function taskActionKeyboard(taskId: number, performanceAlertId?: number | null): TasksBotReplyMarkup {
  const rows: TasksBotInlineButton[][] = [];
  if (performanceAlertId) {
    rows.push([{ text: "👀 Взяти в роботу", callback_data: `task_start:${taskId}` }]);
  }
  rows.push(
    [
      { text: "✅ Виконано", callback_data: `task_done:${taskId}` },
      { text: "⏰ +1 год", callback_data: `task_snooze:${taskId}:60` },
    ],
    [
      { text: "📅 На завтра", callback_data: `task_tomorrow:${taskId}` },
      { text: "🗑 Скасувати", callback_data: `task_cancel:${taskId}` },
    ],
  );
  return { inline_keyboard: rows };
}

export { escapeTelegramHtml };
