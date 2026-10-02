import { getTaskBotUser, taskDueLabel, updatePersonalTask, type PersonalTask } from "@/lib/personal-task-store";
import { escapeTelegramHtml, tasksBotApi } from "@/lib/tasks-bot-telegram";

type TelegramMessageResult = {
  message_id: number;
  chat?: { id?: number | string };
};

function activityChatId() {
  return process.env.TASKS_ACTIVITY_CHAT_ID?.trim() || "";
}

function personLabel(user: Awaited<ReturnType<typeof getTaskBotUser>>, fallbackId: number) {
  if (user?.username) return `@${user.username}`;
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || `ID ${fallbackId}`;
}

function statusBlock(task: PersonalTask) {
  if (task.status === "completed") {
    return {
      title: "✅ ЗАДАЧА ВИКОНАНА",
      line: "✅ <b>Виконано</b>",
    };
  }
  if (task.status === "cancelled") {
    return {
      title: "❌ ЗАДАЧУ СКАСОВАНО",
      line: "❌ <b>Скасовано</b>",
    };
  }
  if (task.work_state === "in_progress") {
    return {
      title: "👀 ЗАДАЧА В РОБОТІ",
      line: "👀 <b>В роботі</b>",
    };
  }
  return {
    title: "📌 НОВА ЗАДАЧА",
    line: "⏳ <b>Очікує</b>",
  };
}

function timestampLabel(value: string | null, timezone: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function renderTaskActivity(task: PersonalTask) {
  const [creator, owner] = await Promise.all([
    getTaskBotUser(task.created_by_telegram_user_id),
    getTaskBotUser(task.owner_telegram_user_id),
  ]);
  const timezone = owner?.timezone || "Europe/Kyiv";
  const status = statusBlock(task);
  const from = personLabel(creator, task.created_by_telegram_user_id);
  const to = personLabel(owner, task.owner_telegram_user_id);

  const timing: string[] = [];
  if (task.started_at) timing.push(`Взято: <b>${escapeTelegramHtml(timestampLabel(task.started_at, timezone))}</b>`);
  if (task.completed_at) timing.push(`Виконано: <b>${escapeTelegramHtml(timestampLabel(task.completed_at, timezone))}</b>`);
  if (task.cancelled_at) timing.push(`Скасовано: <b>${escapeTelegramHtml(timestampLabel(task.cancelled_at, timezone))}</b>`);

  return (
    `${status.title}\n\n` +
    `Від: <b>${escapeTelegramHtml(from)}</b>\n` +
    `Кому: <b>${escapeTelegramHtml(to)}</b>\n` +
    (task.project_name ? `Проєкт: <b>${escapeTelegramHtml(task.project_name)}</b>\n` : "") +
    `Задача: <b>${escapeTelegramHtml(task.title)}</b>\n` +
    `Дедлайн: <b>${escapeTelegramHtml(taskDueLabel(task.due_at, timezone))}</b>\n` +
    `Пріоритет: <b>${task.priority === "high" ? "🔴 Високий" : task.priority === "low" ? "⚪ Низький" : "🟡 Звичайний"}</b>\n\n` +
    `Статус: ${status.line}` +
    (timing.length ? `\n${timing.join("\n")}` : "")
  );
}

export function shouldPublishTaskActivity(task: PersonalTask) {
  return task.source_type === "manager" || task.source_type === "team";
}

export async function publishTaskActivity(task: PersonalTask) {
  const chatId = activityChatId();
  if (!chatId || !shouldPublishTaskActivity(task)) return task;

  const text = await renderTaskActivity(task);
  const message = await tasksBotApi<TelegramMessageResult>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  const updated = await updatePersonalTask(task.id, task.owner_telegram_user_id, {
    activity_chat_id: String(chatId),
    activity_message_id: Number(message.message_id),
    activity_last_synced_at: new Date().toISOString(),
  });
  return updated || task;
}

export async function syncTaskActivity(task: PersonalTask) {
  if (!shouldPublishTaskActivity(task)) return task;
  const chatId = task.activity_chat_id || activityChatId();
  if (!chatId) return task;

  if (!task.activity_message_id) return publishTaskActivity(task);

  const text = await renderTaskActivity(task);
  await tasksBotApi("editMessageText", {
    chat_id: chatId,
    message_id: task.activity_message_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  const updated = await updatePersonalTask(task.id, task.owner_telegram_user_id, {
    activity_last_synced_at: new Date().toISOString(),
  });
  return updated || task;
}
