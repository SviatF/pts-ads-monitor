import {
  clearTaskBotSession,
  createPersonalTask,
  getPersonalTask,
  getTaskBotSession,
  getTaskBotUser,
  listPersonalTasks,
  listTaskBotUsers,
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
  taskFollowupKeyboard,
  tasksBotMainKeyboard,
  type TasksBotReplyMarkup,
} from "@/lib/tasks-bot-telegram";
import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { syncOpenPerformanceTasksForUser } from "@/lib/performance-personal-task-sync";
import { acknowledgePerformanceAlert, resolvePerformanceAlert } from "@/lib/performance-alert-store";

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

function sourceLabel(task: PersonalTask) {
  if (task.source_type === "performance") return "⚡ Performance OS";
  if (task.source_type === "manager") return `👔 Від керівника${task.assigned_by_label ? ` · ${escapeTelegramHtml(task.assigned_by_label)}` : ""}`;
  if (task.source_type === "team") return `📌 Від ${task.assigned_by_label ? escapeTelegramHtml(task.assigned_by_label) : "команди"}`;
  return "👤 Особиста";
}

function taskCard(task: PersonalTask, timezone = "Europe/Kyiv") {
  const project = task.project_name ? ` · <b>${escapeTelegramHtml(task.project_name)}</b>` : "";
  const note = task.notes ? `\n👉 ${escapeTelegramHtml(task.notes)}` : "";
  const perf = task.performance_alert_id ? ` · Alert #${task.performance_alert_id}` : "";
  return `${priorityIcon(task.priority)} <b>${escapeTelegramHtml(task.title)}</b>${project}\n${sourceLabel(task)}${perf}\n⏰ ${escapeTelegramHtml(taskDueLabel(task.due_at, timezone))}${note}\nTask #${task.id}`;
}

async function showTaskList(chatId: number, userId: number, mode: "active" | "today" | "overdue" | "completed" | "assigned") {
  const user = await getTaskBotUser(userId);
  const timezone = user?.timezone || "Europe/Kyiv";
  const status = mode === "completed" ? "completed" : "active";
  const tasks = await listPersonalTasks({ ownerTelegramUserId: userId, status, limit: 40 });
  const now = Date.now();
  const today = localDateKey(new Date(), timezone);

  const filtered = tasks.filter((task) => {
    if (mode === "active" || mode === "completed") return true;
    if (mode === "assigned") return task.source_type === "manager" || task.source_type === "team";
    if (!task.due_at) return false;
    const due = new Date(task.due_at);
    if (mode === "overdue") return due.getTime() < now;
    return localDateKey(due, timezone) === today;
  });

  const title =
    mode === "active" ? "📋 <b>Активні задачі</b>" :
    mode === "today" ? "🔥 <b>На сьогодні</b>" :
    mode === "overdue" ? "⏰ <b>Прострочені</b>" :
    mode === "assigned" ? "📥 <b>Призначені мені</b>" :
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
      replyMarkup: mode === "completed" ? undefined : taskActionKeyboard(task.id, task.performance_alert_id, task.work_state),
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

function managerUsernameSet() {
  return new Set(String(process.env.TASKS_MANAGER_USERNAMES || "").split(",").map((item) => item.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
}

async function startCreateFlow(chatId: number, userId: number) {
  await setTaskBotSession(userId, "await_title", { assignmentMode: "self" });
  await sendTasksBotMessage({
    chatId,
    text: "➕ <b>Нова задача</b>\n\nНапиши коротко, що потрібно зробити.",
    replyMarkup: cancelKeyboard(),
  });
}

async function startAssignFlow(chatId: number, userId: number) {
  const users = (await listTaskBotUsers()).filter((user) => user.telegram_user_id !== userId);
  if (!users.length) {
    await sendTasksBotMessage({
      chatId,
      text: "Поки немає інших користувачів PTS Tasks. Співробітник має хоча б раз відкрити бота і натиснути /start.",
      replyMarkup: tasksBotMainKeyboard,
    });
    return;
  }

  await setTaskBotSession(userId, "await_assignee_pick", { assignmentMode: "other" });

  const rows = users.map((user) => {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    const tag = user.username ? `@${user.username}` : name || `ID ${user.telegram_user_id}`;
    return [{ text: `👤 ${tag}`, callback_data: `assign_user:${user.telegram_user_id}` }];
  });

  await sendTasksBotMessage({
    chatId,
    text: "👥 <b>Кому поставити задачу?</b>\n\nОбери спеціаліста зі списку користувачів, які вже користуються PTS Tasks.",
    replyMarkup: { inline_keyboard: rows },
  });
}

async function finishTaskCreation(chatId: number, userId: number, payload: Record<string, unknown>, priorityText: string) {
  const priority: "high" | "normal" | "low" =
    priorityText.includes("Висок") ? "high" : priorityText.includes("Низ") ? "low" : "normal";
  const creator = await getTaskBotUser(userId);
  const ownerUserId = Number(payload.ownerTelegramUserId || userId);
  const assignee = ownerUserId === userId ? creator : await getTaskBotUser(ownerUserId);
  const isManager = creator?.role === "manager" || managerUsernameSet().has(String(creator?.username || "").toLowerCase());
  const sourceType = ownerUserId === userId ? "self" : isManager ? "manager" : "team";
  const creatorLabel = creator?.username ? `@${creator.username}` : [creator?.first_name, creator?.last_name].filter(Boolean).join(" ") || "Команда";

  const task = await createPersonalTask({
    ownerTelegramUserId: ownerUserId,
    createdByTelegramUserId: userId,
    title: String(payload.title || "").trim(),
    projectName: payload.projectName ? String(payload.projectName) : null,
    dueAt: payload.dueAt ? String(payload.dueAt) : null,
    priority,
    sourceType,
    assignedByLabel: ownerUserId === userId ? null : creatorLabel,
  });
  await clearTaskBotSession(userId);
  await sendTasksBotMessage({
    chatId,
    text:
      `✅ <b>${ownerUserId === userId ? "Задачу створено" : "Задачу призначено"}</b>\n\n` +
      `${priorityLabel(priority)}\n` +
      `<b>${escapeTelegramHtml(task?.title || String(payload.title || ""))}</b>` +
      `${task?.project_name ? `\n📁 ${escapeTelegramHtml(task.project_name)}` : ""}` +
      `\n⏰ ${escapeTelegramHtml(taskDueLabel(task?.due_at || null))}`,
    replyMarkup: tasksBotMainKeyboard,
  });

  if (task && ownerUserId !== userId && assignee) {
    await sendTasksBotMessage({
      chatId: assignee.telegram_chat_id,
      text:
        `📌 <b>НОВА ЗАДАЧА ${sourceType === "manager" ? "ВІД КЕРІВНИКА" : "ВІД КОМАНДИ"}</b>\n\n` +
        `Від: <b>${escapeTelegramHtml(creatorLabel)}</b>\n` +
        `Задача: <b>${escapeTelegramHtml(task.title)}</b>` +
        `${task.project_name ? `\n📁 ${escapeTelegramHtml(task.project_name)}` : ""}` +
        `\n⏰ ${escapeTelegramHtml(taskDueLabel(task.due_at, assignee.timezone || "Europe/Kyiv"))}`,
      replyMarkup: taskActionKeyboard(task.id),
    });
  }
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

function nextWorkingFollowupIso(timezone = "Europe/Kyiv") {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);

  if (hour < 16) return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

  if (hour < 19) {
    return localDateTimeToIso({
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: 19,
      minute: 0,
      timezone,
    });
  }

  const date = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
  do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
  return localDateTimeToIso({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 9,
    minute: 0,
    timezone,
  });
}

async function handleCallback(query: TelegramCallbackQuery) {
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;

  if (data.startsWith("assign_user:")) {
    const assigneeId = Number(data.split(":")[1]);
    const assignee = await getTaskBotUser(assigneeId);
    if (!assignee || assignee.telegram_user_id === userId) {
      await answerTasksBotCallback(query.id, "Користувача не знайдено");
      return;
    }
    await setTaskBotSession(userId, "await_title", {
      assignmentMode: "other",
      ownerTelegramUserId: assignee.telegram_user_id,
      assigneeUsername: assignee.username,
    });
    const tag = assignee.username
      ? `@${escapeTelegramHtml(assignee.username)}`
      : escapeTelegramHtml([assignee.first_name, assignee.last_name].filter(Boolean).join(" ") || String(assignee.telegram_user_id));
    await answerTasksBotCallback(query.id, "Спеціаліста обрано");
    await sendTasksBotMessage({
      chatId,
      text: `👤 Виконавець: <b>${tag}</b>\n\nТепер напиши, що потрібно зробити.`,
      replyMarkup: cancelKeyboard(),
    });
    return;
  }

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

  const match = /^task_(start|working|done|snooze|tomorrow|cancel):(\d+)(?::(\d+))?$/.exec(data);
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

  if (action === "start") {
    const user = await getTaskBotUser(userId);
    const now = new Date();
    const nextFollowupAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    if (task.performance_alert_id) {
      await acknowledgePerformanceAlert(task.performance_alert_id, `tasks-bot:${userId}`);
    }
    await updatePersonalTask(taskId, userId, {
      work_state: "in_progress",
      started_at: task.started_at || now.toISOString(),
      next_followup_at: nextFollowupAt,
      last_followup_at: null,
    });
    await answerTasksBotCallback(query.id, "Взято у роботу 👀");
    await sendTasksBotMessage({
      chatId,
      text:
        `👀 <b>Задачу взято у роботу.</b>\n\n` +
        `<b>${escapeTelegramHtml(task.title)}</b>` +
        (task.performance_alert_id ? `\nAlert #${task.performance_alert_id} підтверджено.` : "") +
        `\n\nЗвичайні нагадування зупинено. Наступний check-in приблизно через 2 години.`,
      replyMarkup: taskFollowupKeyboard(task.id, task.performance_alert_id),
    });
    return;
  }

  if (action === "working") {
    const user = await getTaskBotUser(userId);
    const timezone = user?.timezone || "Europe/Kyiv";
    const nextFollowupAt = nextWorkingFollowupIso(timezone);
    await updatePersonalTask(taskId, userId, {
      work_state: "in_progress",
      last_followup_at: new Date().toISOString(),
      next_followup_at: nextFollowupAt,
    });
    await answerTasksBotCallback(query.id, "Ок, не відволікаю 🔄");
    await sendTasksBotMessage({
      chatId,
      text:
        `🔄 <b>Залишаю задачу в роботі.</b>\n` +
        `${escapeTelegramHtml(task.title)}\n\nНаступний check-in: ${escapeTelegramHtml(taskDueLabel(nextFollowupAt, timezone))}.`,
      replyMarkup: taskFollowupKeyboard(task.id, task.performance_alert_id),
    });
    return;
  }

  if (action === "done") {
    if (task.performance_alert_id) {
      await resolvePerformanceAlert(task.performance_alert_id, `tasks-bot:${userId}`);
    }
    await updatePersonalTask(taskId, userId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      next_followup_at: null,
      last_followup_at: new Date().toISOString(),
    });
    await answerTasksBotCallback(query.id, "Готово ✅");
    await sendTasksBotMessage({
      chatId,
      text: task.performance_alert_id
        ? `✅ <b>Performance-задачу закрито.</b> Alert #${task.performance_alert_id} також автоматично закритий у Meta Ads групі.`
        : `✅ Виконано: <b>${escapeTelegramHtml(task.title)}</b>`,
      replyMarkup: tasksBotMainKeyboard,
    });
    return;
  }

  if (action === "cancel") {
    await updatePersonalTask(taskId, userId, {
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      next_followup_at: null,
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
      work_state: "new",
      started_at: null,
      next_followup_at: null,
      last_followup_at: null,
      reminded_2h_at: null,
      reminded_due_at: null,
      reminded_overdue_at: null,
    });
    await answerTasksBotCallback(query.id, `Перенесено на +${minutes} хв`);
    await sendTasksBotMessage({ chatId, text: `⏰ <b>${escapeTelegramHtml(task.title)}</b> → ${escapeTelegramHtml(taskDueLabel(dueAt))}`, replyMarkup: taskActionKeyboard(taskId, task.performance_alert_id, task.work_state) });
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
      work_state: "new",
      started_at: null,
      next_followup_at: null,
      last_followup_at: null,
      reminded_2h_at: null,
      reminded_due_at: null,
      reminded_overdue_at: null,
    });
    await answerTasksBotCallback(query.id, "Перенесено на завтра");
    await sendTasksBotMessage({ chatId, text: `📅 <b>${escapeTelegramHtml(task.title)}</b> → завтра, ${escapeTelegramHtml(taskDueLabel(dueAt))}`, replyMarkup: taskActionKeyboard(taskId, task.performance_alert_id, task.work_state) });
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
    try {
      const configs = await listPerformanceMonitoringConfigs();
      const synced = await syncOpenPerformanceTasksForUser({ telegramUserId: userId, username: message.from.username, configs });
      if (synced.created > 0) {
        await sendTasksBotMessage({ chatId, text: `⚡ Підтягнув <b>${synced.created}</b> відкритих Performance OS задач у твій особистий задачник.` });
      }
    } catch (error) {
      console.warn("Could not sync open performance tasks on /start", error);
    }
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
  if (text === "👥 Поставити задачу") {
    await startAssignFlow(chatId, userId);
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
  if (text === "📥 Призначені мені") {
    await showTaskList(chatId, userId, "assigned");
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
