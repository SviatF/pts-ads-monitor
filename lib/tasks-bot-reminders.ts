import {
  listActiveTasksDueBefore,
  listActiveTasksDueBetween,
  listPersonalTasks,
  listTaskBotUsers,
  localClock,
  localDateKey,
  taskDueLabel,
  updatePersonalTask,
  updateTaskBotUser,
  type PersonalTask,
  type TaskBotUser,
} from "@/lib/personal-task-store";
import {
  escapeTelegramHtml,
  priorityIcon,
  sendTasksBotMessage,
  taskActionKeyboard,
} from "@/lib/tasks-bot-telegram";

function taskLine(task: PersonalTask, timezone: string) {
  const project = task.project_name ? ` · ${escapeTelegramHtml(task.project_name)}` : "";
  return `${priorityIcon(task.priority)} <b>${escapeTelegramHtml(task.title)}</b>${project} · ${escapeTelegramHtml(taskDueLabel(task.due_at, timezone))}`;
}

function targetClock(value: string) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

function inTenMinuteWindow(user: TaskBotUser, timeValue: string, now: Date) {
  const target = targetClock(timeValue);
  if (!target) return false;
  const local = localClock(now, user.timezone);
  const nowMinutes = local.hour * 60 + local.minute;
  const targetMinutes = target.hour * 60 + target.minute;
  return nowMinutes >= targetMinutes && nowMinutes < targetMinutes + 10;
}

async function sendTaskReminder(task: PersonalTask, kind: "2h" | "due" | "overdue", user: TaskBotUser) {
  const header =
    kind === "2h" ? "⏰ <b>Дедлайн через ~2 години</b>" :
    kind === "due" ? "🔔 <b>Дедлайн настав</b>" :
    "🔴 <b>Задача прострочена</b>";

  const detail =
    kind === "2h" ? "Перевір, чи встигаєш закрити її вчасно." :
    kind === "due" ? "Закрий задачу або одразу перенеси дедлайн." :
    "Якщо задача ще актуальна — закрий або перенеси її.";

  await sendTasksBotMessage({
    chatId: user.telegram_chat_id,
    text:
      `${header}\n\n` +
      `${priorityIcon(task.priority)} <b>${escapeTelegramHtml(task.title)}</b>` +
      `${task.project_name ? `\n📁 ${escapeTelegramHtml(task.project_name)}` : ""}` +
      `\n⏰ ${escapeTelegramHtml(taskDueLabel(task.due_at, user.timezone))}\n\n${detail}`,
    replyMarkup: taskActionKeyboard(task.id),
  });

  const nowIso = new Date().toISOString();
  if (kind === "2h") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_2h_at: nowIso });
  if (kind === "due") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_due_at: nowIso });
  if (kind === "overdue") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_overdue_at: nowIso });
}

async function sendMorningDigest(user: TaskBotUser, now: Date) {
  const tasks = await listPersonalTasks({ ownerTelegramUserId: user.telegram_user_id, status: "active", limit: 50 });
  const today = localDateKey(now, user.timezone);
  const nowMs = now.getTime();
  const overdue = tasks.filter((task) => task.due_at && new Date(task.due_at).getTime() < nowMs);
  const todayTasks = tasks.filter((task) => task.due_at && localDateKey(new Date(task.due_at), user.timezone) === today && new Date(task.due_at).getTime() >= nowMs);
  const high = [...overdue, ...todayTasks].filter((task) => task.priority === "high").length;

  const rows = [...overdue, ...todayTasks].slice(0, 8).map((task) => taskLine(task, user.timezone));
  const text = rows.length
    ? `☀️ <b>Задачі на сьогодні</b>\n\n${rows.join("\n")}\n\nВсього на контролі: <b>${overdue.length + todayTasks.length}</b>${high ? ` · 🔴 високий пріоритет: <b>${high}</b>` : ""}`
    : "☀️ <b>Задачі на сьогодні</b>\n\n🟢 На сьогодні дедлайнів немає.";

  await sendTasksBotMessage({ chatId: user.telegram_chat_id, text });
  await updateTaskBotUser(user.telegram_user_id, { last_morning_digest_date: today });
}

async function sendEveningDigest(user: TaskBotUser, now: Date) {
  const [active, completed] = await Promise.all([
    listPersonalTasks({ ownerTelegramUserId: user.telegram_user_id, status: "active", limit: 50 }),
    listPersonalTasks({ ownerTelegramUserId: user.telegram_user_id, status: "completed", limit: 50 }),
  ]);
  const today = localDateKey(now, user.timezone);
  const doneToday = completed.filter((task) => task.completed_at && localDateKey(new Date(task.completed_at), user.timezone) === today);
  const overdue = active.filter((task) => task.due_at && new Date(task.due_at).getTime() < now.getTime());
  const dueTodayUnfinished = active.filter((task) => task.due_at && localDateKey(new Date(task.due_at), user.timezone) === today);

  const rows = [...overdue, ...dueTodayUnfinished.filter((task) => !overdue.some((item) => item.id === task.id))]
    .slice(0, 6)
    .map((task) => taskLine(task, user.timezone));

  await sendTasksBotMessage({
    chatId: user.telegram_chat_id,
    text:
      `🌙 <b>Підсумок дня</b>\n\n` +
      `✅ Виконано сьогодні: <b>${doneToday.length}</b>\n` +
      `⏳ Активних: <b>${active.length}</b>\n` +
      `🔴 Прострочено: <b>${overdue.length}</b>` +
      (rows.length ? `\n\n<b>Що залишилось на контролі:</b>\n${rows.join("\n")}` : "\n\n🟢 Прострочених задач немає."),
  });
  await updateTaskBotUser(user.telegram_user_id, { last_evening_digest_date: today });
}

export async function runTasksBotReminders() {
  const now = new Date();
  const users = await listTaskBotUsers();
  const userMap = new Map(users.map((user) => [user.telegram_user_id, user]));
  let reminders = 0;
  let digests = 0;
  const errors: string[] = [];

  const twoHourStart = new Date(now.getTime() + 110 * 60_000).toISOString();
  const twoHourEnd = new Date(now.getTime() + 130 * 60_000).toISOString();
  const dueStart = new Date(now.getTime() - 120 * 60_000).toISOString();
  const overdueCutoff = new Date(now.getTime() - 120 * 60_000).toISOString();

  const [twoHourTasks, dueTasks, overdueTasks] = await Promise.all([
    listActiveTasksDueBetween(twoHourStart, twoHourEnd),
    listActiveTasksDueBetween(dueStart, now.toISOString()),
    listActiveTasksDueBefore(overdueCutoff),
  ]);

  for (const task of twoHourTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_2h_at) continue;
    try {
      await sendTaskReminder(task, "2h", user);
      reminders += 1;
    } catch (error) {
      errors.push(`2h #${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const task of dueTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_due_at) continue;
    try {
      await sendTaskReminder(task, "due", user);
      reminders += 1;
    } catch (error) {
      errors.push(`due #${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const task of overdueTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_overdue_at) continue;
    try {
      await sendTaskReminder(task, "overdue", user);
      reminders += 1;
    } catch (error) {
      errors.push(`overdue #${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const user of users) {
    const today = localDateKey(now, user.timezone);
    if (user.morning_digest_enabled && user.last_morning_digest_date !== today && inTenMinuteWindow(user, user.morning_digest_time, now)) {
      try {
        await sendMorningDigest(user, now);
        digests += 1;
      } catch (error) {
        errors.push(`morning ${user.telegram_user_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (user.evening_digest_enabled && user.last_evening_digest_date !== today && inTenMinuteWindow(user, user.evening_digest_time, now)) {
      try {
        await sendEveningDigest(user, now);
        digests += 1;
      } catch (error) {
        errors.push(`evening ${user.telegram_user_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { users: users.length, reminders, digests, errors };
}
