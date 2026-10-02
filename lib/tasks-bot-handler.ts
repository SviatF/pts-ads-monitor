import {
  clearTaskBotSession,
  createPersonalTask,
  getPersonalTask,
  getTaskBotSession,
  getTaskBotUser,
  listPersonalTasks,
  localDateKey,
  localDateTimeToIso,
  parseCustomDeadline,
  setTaskBotSession,
  taskDueLabel,
  updatePersonalTask,
  updateTaskBotUser,
  upsertTaskBotUser,
  type PersonalTask,
} from "@/lib/personal-task-store";
import {
  answerTasksBotCallback,
  escapeTelegramHtml,
  priorityIcon,
  priorityLabel,
  sendTasksBotMessage,
  taskActionKeyboard,
  tasksBotMainKeyboard,
  type TasksBotReplyMarkup,
} from "@/lib/tasks-bot-telegram";

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

export type TasksBotUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

function mainMenuText(firstName?: string) {
  const hello = firstName ? `, ${escapeTelegramHtml(firstName)}` : "";
  return `👋 <b>PTS Tasks</b>${hello}\n\nТут твої особисті задачі: створюй, контролюй дедлайни та закривай прямо в Telegram.`;
}

function cancelKeyboard(): TasksBotReplyMarkup {
  return {
    keyboard: [[{ text: "⬅️ Скасувати" }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function deadlineKeyboard(): TasksBotReplyMarkup {
  return {
    keyboard: [
      [{ text: "Сьогодні" }, { text: "Завтра" }],
      [{ text: "Без дедлайну" }, { text: "Інша дата" }],
      [{ text: "⬅️ Скасувати" }],
    ],
    resize_keyboard: true,
  };
}

function timeKeyboard(): TasksBotReplyMarkup {
  return {
    keyboard: [
      [{ text: "10:00" }, { text: "12:00" }, { text: "15:00" }, { text: "18:00" }],
      [{ text: "Інший час" }, { text: "⬅️ Скасувати" }],
    ],
    resize_keyboard: true,
  };
}

function priorityKeyboard(): TasksBotReplyMarkup {
  return {
    keyboard: [
      [{ text: "🔴 Високий" }, { text: "🟡 Звичайний" }, { text: "⚪ Низький" }],
      [{ text: "⬅️ Скасувати" }],
    ],
    resize_keyboard: true,
  };
}

function settingsKeyboard(user: Awaited<ReturnType<typeof getTaskBotUser>>): TasksBotReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: `${user?.reminders_enabled ? "✅" : "❌"} Нагадування`, callback_data: "settings:reminders" }],
      [{ text: `${user?.morning_digest_enabled ? "✅" : "❌"} Ранковий дайджест`, callback_data: "settings:morning" }],
      [{ text: `${user?.evening_digest_enabled ? "✅" : "❌"} Вечірній підсумок`, callback_data: "settings:evening" }],
    ],
  };
}

function parseTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function datePartsForOffset(days: number, timezone = "Europe/Kyiv") {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = formatter.format(now);
  const [year, month, day] = today.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function taskCard(task: PersonalTask, timezone = "Europe/Kyiv") {
  const project = task.project_name ? ` · <b>${escapeTelegramHtml(task.project_name)}</b>` : "";
  return `${priorityIcon(task.priority)} <b>${escapeTelegramHtml(task.title)}</b>${project}\n⏰ ${escapeTelegramHtml(taskDueLabel(task.due_at, timezone))} · #${task.id}`;
}

async function showTaskList(chatId: number, userId: number, mode: "active" | "today" | "overdue" | "completed") {
  const user = await getTaskBotUser(userId);
  const timezone = user?.timezone || "Europe/Kyiv";
  const status = mode === "completed" ? "completed" : "active";
  const tasks = await listPersonalTasks({ ownerTelegramUserId: userId, status, limit: 40 });
  const now = Date.now();
  const today = localDateKey(new Date(), timezone);

  const filtered = tasks.filter((task) => {
    if (mode === "active" || mode === "completed") return true;
    if (!task.due_at) return false;
    const due = new Date(task.due_at);
    if (mode === "overdue") return due.getTime() < now;
    return localDateKey(due, timezone) === today;
  });

  const title =
    mode === "active" ? "📋 <b>Активні задачі</b>" :
    mode === "today" ? "🔥 <b>На сьогодні</b>" :
    mode === "overdue" ? "⏰ <b>Прострочені</b>" :
    "✅ <b>Виконані</b>";

  if (!filtered.length) {
    await sendTasksBotMessage({ chatId, text: `${title}\n\nЗадач немає.`, replyMarkup: tasksBotMainKeyboard });
    return;
  }

  await sendTasksBotMessage({ chatId, text: `${title}\n\nЗнайдено: <b>${filtered.length}</b>` });
  for (const task of filtered.slice(0, 15)) {
    await sendTasksBotMessage({
      chatId,
      text: taskCard(task, timezone),
      replyMarkup: mode === "completed" ? undefined : taskActionKeyboard(task.id),
    });
  }
  if (filtered.length > 15) {
    await sendTasksBotMessage({ chatId, text: `Ще ${filtered.length - 15} задач не показано. Закрий частину або переглянь пізніше.` });
  }
}

async function showSettings(chatId: number, userId: number) {
  const user = await getTaskBotUser(userId);
  await sendTasksBotMessage({
    chatId,
    text:
      `⚙️ <b>Налаштування</b>\n\n` +
      `Нагадування: <b>${user?.reminders_enabled ? "ON" : "OFF"}</b>\n` +
      `Ранковий дайджест: <b>${user?.morning_digest_enabled ? "09:00" : "OFF"}</b>\n` +
      `Вечірній підсумок: <b>${user?.evening_digest_enabled ? "19:00" : "OFF"}</b>\n` +
      `Часовий пояс: <b>${escapeTelegramHtml(user?.timezone || "Europe/Kyiv")}</b>`,
    replyMarkup: settingsKeyboard(user),
  });
}

async function startCreateFlow(chatId: number, userId: number) {
  await setTaskBotSession(userId, "await_title", {});
  await sendTasksBotMessage({
    chatId,
    text: "➕ <b>Нова задача</b>\n\nНапиши коротко, що потрібно зробити.",
    replyMarkup: cancelKeyboard(),
  });
}

async function finishTaskCreation(chatId: number, userId: number, payload: Record<string, unknown>, priorityText: string) {
  const priority: "high" | "normal" | "low" =
    priorityText.includes("Висок") ? "high" : priorityText.includes("Низ") ? "low" : "normal";
  const task = await createPersonalTask({
    ownerTelegramUserId: userId,
    createdByTelegramUserId: userId,
    title: String(payload.title || "").trim(),
    projectName: payload.projectName ? String(payload.projectName) : null,
    dueAt: payload.dueAt ? String(payload.dueAt) : null,
    priority,
  });
  await clearTaskBotSession(userId);
  await sendTasksBotMessage({
    chatId,
    text:
      `✅ <b>Задачу створено</b>\n\n` +
      `${priorityLabel(priority)}\n` +
      `<b>${escapeTelegramHtml(task?.title || String(payload.title || ""))}</b>` +
      `${task?.project_name ? `\n📁 ${escapeTelegramHtml(task.project_name)}` : ""}` +
      `\n⏰ ${escapeTelegramHtml(taskDueLabel(task?.due_at || null))}`,
    replyMarkup: tasksBotMainKeyboard,
  });
}

async function handleCreateSession(chatId: number, userId: number, text: string) {
  const session = await getTaskBotSession(userId);
  if (!session) return false;
  if (text === "⬅️ Скасувати") {
    await clearTaskBotSession(userId);
    await sendTasksBotMessage({ chatId, text: "Створення задачі скасовано.", replyMarkup: tasksBotMainKeyboard });
    return true;
  }

  const payload = { ...(session.payload || {}) };

  if (session.state === "await_title") {
    if (text.length < 2) {
      await sendTasksBotMessage({ chatId, text: "Назва надто коротка. Напиши, що саме потрібно зробити." });
      return true;
    }
    payload.title = text.slice(0, 240);
    await setTaskBotSession(userId, "await_project", payload);
    await sendTasksBotMessage({
      chatId,
      text: "📁 До якого проєкту відноситься задача?\n\nНапиши назву або натисни «Без проєкту».",
      replyMarkup: {
        keyboard: [[{ text: "Без проєкту" }], [{ text: "⬅️ Скасувати" }]],
        resize_keyboard: true,
      },
    });
    return true;
  }

  if (session.state === "await_project") {
    payload.projectName = text === "Без проєкту" ? null : text.slice(0, 120);
    await setTaskBotSession(userId, "await_deadline", payload);
    await sendTasksBotMessage({ chatId, text: "📅 Коли дедлайн?", replyMarkup: deadlineKeyboard() });
    return true;
  }

  if (session.state === "await_deadline") {
    if (text === "Без дедлайну") {
      payload.dueAt = null;
      await setTaskBotSession(userId, "await_priority", payload);
      await sendTasksBotMessage({ chatId, text: "⚡ Обери пріоритет.", replyMarkup: priorityKeyboard() });
      return true;
    }
    if (text === "Інша дата") {
      await setTaskBotSession(userId, "await_custom_deadline", payload);
      await sendTasksBotMessage({
        chatId,
        text: "Введи дату й час у форматі <code>05.10 15:30</code> або <code>05.10.2026 15:30</code>.",
        replyMarkup: cancelKeyboard(),
      });
      return true;
    }
    if (text === "Сьогодні" || text === "Завтра") {
      payload.dayOffset = text === "Завтра" ? 1 : 0;
      await setTaskBotSession(userId, "await_time", payload);
      await sendTasksBotMessage({ chatId, text: "🕒 На котру годину?", replyMarkup: timeKeyboard() });
      return true;
    }
    await sendTasksBotMessage({ chatId, text: "Обери один із варіантів дедлайну кнопкою нижче.", replyMarkup: deadlineKeyboard() });
    return true;
  }

  if (session.state === "await_time") {
    if (text === "Інший час") {
      await setTaskBotSession(userId, "await_manual_time", payload);
      await sendTasksBotMessage({ chatId, text: "Введи час у форматі <code>14:30</code>.", replyMarkup: cancelKeyboard() });
      return true;
    }
    const parsed = parseTime(text);
    if (!parsed) {
      await sendTasksBotMessage({ chatId, text: "Не розпізнав час. Наприклад: <code>14:30</code>." });
      return true;
    }
    const parts = datePartsForOffset(Number(payload.dayOffset || 0));
    payload.dueAt = localDateTimeToIso({ ...parts, ...parsed });
    await setTaskBotSession(userId, "await_priority", payload);
    await sendTasksBotMessage({ chatId, text: "⚡ Обери пріоритет.", replyMarkup: priorityKeyboard() });
    return true;
  }

  if (session.state === "await_manual_time") {
    const parsed = parseTime(text);
    if (!parsed) {
      await sendTasksBotMessage({ chatId, text: "Не розпізнав час. Наприклад: <code>14:30</code>." });
      return true;
    }
    const parts = datePartsForOffset(Number(payload.dayOffset || 0));
    payload.dueAt = localDateTimeToIso({ ...parts, ...parsed });
    await setTaskBotSession(userId, "await_priority", payload);
    await sendTasksBotMessage({ chatId, text: "⚡ Обери пріоритет.", replyMarkup: priorityKeyboard() });
    return true;
  }

  if (session.state === "await_custom_deadline") {
    const dueAt = parseCustomDeadline(text);
    if (!dueAt) {
      await sendTasksBotMessage({ chatId, text: "Не розпізнав дату або вона вже минула. Приклад: <code>05.10 15:30</code>." });
      return true;
    }
    payload.dueAt = dueAt;
    await setTaskBotSession(userId, "await_priority", payload);
    await sendTasksBotMessage({ chatId, text: "⚡ Обери пріоритет.", replyMarkup: priorityKeyboard() });
    return true;
  }

  if (session.state === "await_priority") {
    if (!["🔴 Високий", "🟡 Звичайний", "⚪ Низький"].includes(text)) {
      await sendTasksBotMessage({ chatId, text: "Обери пріоритет кнопкою нижче.", replyMarkup: priorityKeyboard() });
      return true;
    }
    await finishTaskCreation(chatId, userId, payload, text);
    return true;
  }

  return false;
}

async function handleCallback(query: TelegramCallbackQuery) {
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;

  if (data.startsWith("settings:")) {
    const user = await getTaskBotUser(userId);
    if (!user) return;
    const key = data.split(":")[1];
    if (key === "reminders") await updateTaskBotUser(userId, { reminders_enabled: !user.reminders_enabled });
    if (key === "morning") await updateTaskBotUser(userId, { morning_digest_enabled: !user.morning_digest_enabled });
    if (key === "evening") await updateTaskBotUser(userId, { evening_digest_enabled: !user.evening_digest_enabled });
    await answerTasksBotCallback(query.id, "Збережено");
    await showSettings(chatId, userId);
    return;
  }

  const match = /^task_(done|snooze|tomorrow|cancel):(\d+)(?::(\d+))?$/.exec(data);
  if (!match) {
    await answerTasksBotCallback(query.id);
    return;
  }
  const action = match[1];
  const taskId = Number(match[2]);
  const task = await getPersonalTask(taskId, userId);
  if (!task) {
    await answerTasksBotCallback(query.id, "Задачу не знайдено");
    return;
  }

  if (action === "done") {
    await updatePersonalTask(taskId, userId, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
    await answerTasksBotCallback(query.id, "Готово ✅");
    await sendTasksBotMessage({ chatId, text: `✅ Виконано: <b>${escapeTelegramHtml(task.title)}</b>`, replyMarkup: tasksBotMainKeyboard });
    return;
  }

  if (action === "cancel") {
    await updatePersonalTask(taskId, userId, {
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    });
    await answerTasksBotCallback(query.id, "Скасовано");
    await sendTasksBotMessage({ chatId, text: `🗑 Скасовано: <b>${escapeTelegramHtml(task.title)}</b>`, replyMarkup: tasksBotMainKeyboard });
    return;
  }

  if (action === "snooze") {
    const minutes = Math.max(15, Number(match[3] || 60));
    const base = task.due_at ? Math.max(Date.now(), new Date(task.due_at).getTime()) : Date.now();
    const dueAt = new Date(base + minutes * 60_000).toISOString();
    await updatePersonalTask(taskId, userId, {
      due_at: dueAt,
      reminded_2h_at: null,
      reminded_due_at: null,
      reminded_overdue_at: null,
    });
    await answerTasksBotCallback(query.id, `Перенесено на +${minutes} хв`);
    await sendTasksBotMessage({ chatId, text: `⏰ <b>${escapeTelegramHtml(task.title)}</b> → ${escapeTelegramHtml(taskDueLabel(dueAt))}`, replyMarkup: taskActionKeyboard(taskId) });
    return;
  }

  if (action === "tomorrow") {
    const current = task.due_at ? new Date(task.due_at) : new Date();
    const clockParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Kyiv",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(current);
    const clock = Object.fromEntries(clockParts.map((part) => [part.type, part.value]));
    const parts = datePartsForOffset(1);
    const dueAt = localDateTimeToIso({
      ...parts,
      hour: Number(clock.hour || 10),
      minute: Number(clock.minute || 0),
    });
    await updatePersonalTask(taskId, userId, {
      due_at: dueAt,
      reminded_2h_at: null,
      reminded_due_at: null,
      reminded_overdue_at: null,
    });
    await answerTasksBotCallback(query.id, "Перенесено на завтра");
    await sendTasksBotMessage({ chatId, text: `📅 <b>${escapeTelegramHtml(task.title)}</b> → завтра, ${escapeTelegramHtml(taskDueLabel(dueAt))}`, replyMarkup: taskActionKeyboard(taskId) });
  }
}

export async function handleTasksBotUpdate(update: TasksBotUpdate) {
  if (update.callback_query) {
    const query = update.callback_query;
    const chat = query.message?.chat;
    if (!chat || chat.type !== "private") {
      await answerTasksBotCallback(query.id, "PTS Tasks працює лише в особистому чаті");
      return;
    }
    await upsertTaskBotUser({
      telegramUserId: query.from.id,
      telegramChatId: chat.id,
      username: query.from.username,
      firstName: query.from.first_name,
      lastName: query.from.last_name,
    });
    await handleCallback(query);
    return;
  }

  const message = update.message;
  if (!message?.from || typeof message.text !== "string") return;
  if (message.chat.type !== "private") {
    await sendTasksBotMessage({
      chatId: message.chat.id,
      text: "🔒 PTS Tasks працює тільки в особистому чаті з ботом.",
    });
    return;
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  await upsertTaskBotUser({
    telegramUserId: userId,
    telegramChatId: chatId,
    username: message.from.username,
    firstName: message.from.first_name,
    lastName: message.from.last_name,
  });

  if (/^\/start(?:@\w+)?$/i.test(text) || /^\/menu(?:@\w+)?$/i.test(text)) {
    await clearTaskBotSession(userId);
    await sendTasksBotMessage({
      chatId,
      text: mainMenuText(message.from.first_name),
      replyMarkup: tasksBotMainKeyboard,
    });
    return;
  }

  const sessionHandled = await handleCreateSession(chatId, userId, text);
  if (sessionHandled) return;

  if (text === "➕ Додати задачу") {
    await startCreateFlow(chatId, userId);
    return;
  }
  if (text === "📋 Активні задачі") {
    await showTaskList(chatId, userId, "active");
    return;
  }
  if (text === "🔥 На сьогодні") {
    await showTaskList(chatId, userId, "today");
    return;
  }
  if (text === "⏰ Прострочені") {
    await showTaskList(chatId, userId, "overdue");
    return;
  }
  if (text === "✅ Виконані") {
    await showTaskList(chatId, userId, "completed");
    return;
  }
  if (text === "⚙️ Налаштування") {
    await showSettings(chatId, userId);
    return;
  }

  await sendTasksBotMessage({
    chatId,
    text: "Обери дію з меню нижче.",
    replyMarkup: tasksBotMainKeyboard,
  });
}
