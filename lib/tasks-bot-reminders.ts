import {
  listActiveTasksDueBefore,
  listActiveTasksDueBetween,
  listActiveTasksForFollowup,
  listActiveTasksForUser,
  listTaskBotUsers,
  localClock,
  localDateKey,
  taskDueLabel,
  updatePersonalTask,
  type PersonalTask,
  type TaskBotUser,
} from "@/lib/personal-task-store";
import {
  escapeTelegramHtml,
  priorityIcon,
  sendTasksBotMessage,
  taskActionKeyboard,
  taskFollowupKeyboard,
} from "@/lib/tasks-bot-telegram";
import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { syncOpenPerformanceTasksForUser } from "@/lib/performance-personal-task-sync";

type PushSlot = 9 | 13 | 16 | 19;

function taskSourceLabel(task: PersonalTask) {
  if (task.source_type === "performance") return "⚡ Performance OS";
  if (task.source_type === "manager") return `👔 Від керівника${task.assigned_by_label ? ` · ${escapeTelegramHtml(task.assigned_by_label)}` : ""}`;
  if (task.source_type === "team") return `📌 Від ${task.assigned_by_label ? escapeTelegramHtml(task.assigned_by_label) : "команди"}`;
  return "👤 Особиста";
}

function taskMessage(task: PersonalTask, timezone: string, prefix = "") {
  return (
    (prefix ? `${prefix}\n\n` : "") +
    `${priorityIcon(task.priority)} <b>${escapeTelegramHtml(task.title)}</b>` +
    (task.project_name ? `\n📁 ${escapeTelegramHtml(task.project_name)}` : "") +
    `\n${taskSourceLabel(task)}` +
    (task.performance_alert_id ? ` · Alert #${task.performance_alert_id}` : "") +
    `\n⏰ ${escapeTelegramHtml(taskDueLabel(task.due_at, timezone))}` +
    (task.notes ? `\n👉 ${escapeTelegramHtml(task.notes)}` : "")
  );
}

function weekdayInTimezone(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" }).format(date);
}

function isWeekendForUser(date: Date, timezone: string) {
  const day = weekdayInTimezone(date, timezone);
  return day === "Sat" || day === "Sun";
}

function scheduleSlot(user: TaskBotUser, now: Date): PushSlot | null {
  const { hour, minute } = localClock(now, user.timezone);
  if (minute >= 10) return null;
  if (hour === 9 || hour === 13 || hour === 16 || hour === 19) return hour;
  return null;
}

function tomorrowKey(now: Date, timezone: string) {
  const today = localDateKey(now, timezone);
  const [year, month, day] = today.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function isOverdue(task: PersonalTask, now: Date) {
  return Boolean(task.due_at && new Date(task.due_at).getTime() < now.getTime());
}

function dueToday(task: PersonalTask, user: TaskBotUser, now: Date) {
  return Boolean(task.due_at && localDateKey(new Date(task.due_at), user.timezone) === localDateKey(now, user.timezone));
}

function dueTomorrow(task: PersonalTask, user: TaskBotUser, now: Date) {
  return Boolean(task.due_at && localDateKey(new Date(task.due_at), user.timezone) === tomorrowKey(now, user.timezone));
}

function isHighAttention(task: PersonalTask, user: TaskBotUser, now: Date) {
  return (
    task.priority === "high" ||
    task.source_type === "manager" ||
    isOverdue(task, now) ||
    dueToday(task, user, now)
  );
}

function shouldPushAtSlot(task: PersonalTask, user: TaskBotUser, now: Date, slot: PushSlot) {
  // Every unresolved task comes back every workday at 09:00, even if already in progress.
  if (slot === 9) return true;

  // After "Взято у роботу" ordinary schedule pushes stop.
  if (task.work_state === "in_progress") return false;

  if (slot === 13) return isHighAttention(task, user, now);
  if (slot === 16 || slot === 19) {
    return isHighAttention(task, user, now) || dueTomorrow(task, user, now);
  }
  return false;
}

function weekendEligible(task: PersonalTask, user: TaskBotUser, now: Date) {
  return task.priority === "high" || isOverdue(task, now) || dueToday(task, user, now);
}

function slotHeading(slot: PushSlot) {
  if (slot === 9) return "☀️ <b>ЗАДАЧІ НА СЬОГОДНІ</b>";
  if (slot === 13) return "🕐 <b>CHECK-IN · 13:00</b>";
  if (slot === 16) return "🕓 <b>CHECK-IN · 16:00</b>";
  return "🌙 <b>ФІНАЛЬНИЙ CHECK · 19:00</b>";
}

async function sendScheduledPushes(user: TaskBotUser, now: Date) {
  const slot = scheduleSlot(user, now);
  if (!slot || !user.reminders_enabled) return 0;

  const tasks = await listActiveTasksForUser(user.telegram_user_id, 100);
  if (!tasks.length) return 0;

  const weekend = isWeekendForUser(now, user.timezone);
  const slotKey = `${localDateKey(now, user.timezone)}:${slot}`;

  const eligible = tasks.filter((task) => {
    if (task.last_schedule_push_key === slotKey) return false;
    if (weekend) {
      // No normal weekend cadence. Only urgent/weekend-deadline items are allowed.
      return weekendEligible(task, user, now) && slot === 9;
    }
    return shouldPushAtSlot(task, user, now, slot);
  });

  if (!eligible.length) return 0;

  await sendTasksBotMessage({
    chatId: user.telegram_chat_id,
    text:
      `${slotHeading(slot)}\n\n` +
      (slot === 9
        ? `Невиконаних задач: <b>${eligible.length}</b>. Усі відкриті задачі повертаються щоранку, доки не будуть закриті.`
        : `Ще потребують уваги: <b>${eligible.length}</b>.`),
  });

  let sent = 0;
  for (const task of eligible.slice(0, 30)) {
    const started = task.work_state === "in_progress";
    const prefix =
      slot === 9 && started
        ? "👀 <b>В роботі з попереднього періоду</b>"
        : isOverdue(task, now)
          ? "🔴 <b>ПРОСТРОЧЕНО</b>"
          : "";
    await sendTasksBotMessage({
      chatId: user.telegram_chat_id,
      text: taskMessage(task, user.timezone, prefix),
      replyMarkup: started
        ? taskFollowupKeyboard(task.id, task.performance_alert_id)
        : taskActionKeyboard(task.id, task.performance_alert_id, task.work_state),
    });
    await updatePersonalTask(task.id, task.owner_telegram_user_id, { last_schedule_push_key: slotKey });
    sent += 1;
  }
  return sent;
}

async function sendTaskDeadlineReminder(task: PersonalTask, kind: "2h" | "due" | "overdue", user: TaskBotUser) {
  // Once a task is in progress, only the dedicated follow-up flow may disturb the user.
  if (task.work_state === "in_progress") return 0;

  const header =
    kind === "2h" ? "⏰ <b>Дедлайн через ~2 години</b>" :
    kind === "due" ? "🔔 <b>Дедлайн настав</b>" :
    "🔴 <b>Задача прострочена на 2+ години</b>";

  const detail =
    kind === "2h" ? "Візьми у роботу зараз або перенеси дедлайн." :
    kind === "due" ? "Закрий задачу, візьми у роботу або одразу перенеси." :
    "Якщо задача ще актуальна — візьми у роботу або перенеси її.";

  await sendTasksBotMessage({
    chatId: user.telegram_chat_id,
    text: `${taskMessage(task, user.timezone, header)}\n\n${detail}`,
    replyMarkup: taskActionKeyboard(task.id, task.performance_alert_id, task.work_state),
  });

  const nowIso = new Date().toISOString();
  if (kind === "2h") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_2h_at: nowIso });
  if (kind === "due") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_due_at: nowIso });
  if (kind === "overdue") await updatePersonalTask(task.id, task.owner_telegram_user_id, { reminded_overdue_at: nowIso });
  return 1;
}

async function sendInProgressFollowup(task: PersonalTask, user: TaskBotUser) {
  const nowIso = new Date().toISOString();
  await sendTasksBotMessage({
    chatId: user.telegram_chat_id,
    text:
      `👀 <b>Як по задачі?</b>\n\n` +
      taskMessage(task, user.timezone) +
      `\n\nЯкщо ще працюєш — натисни «🔄 Ще в роботі», і я не буду зайвий раз відволікати.`,
    replyMarkup: taskFollowupKeyboard(task.id, task.performance_alert_id),
  });
  await updatePersonalTask(task.id, task.owner_telegram_user_id, {
    last_followup_at: nowIso,
    next_followup_at: null,
  });
  return 1;
}

export async function runTasksBotReminders() {
  const now = new Date();
  const [users, performanceConfigs] = await Promise.all([
    listTaskBotUsers(),
    listPerformanceMonitoringConfigs(),
  ]);
  const userMap = new Map(users.map((user) => [user.telegram_user_id, user]));
  let reminders = 0;
  let scheduledPushes = 0;
  let followups = 0;
  const errors: string[] = [];

  // First, make sure every open actionable Performance OS alert exists in the owner's personal inbox.
  for (const user of users) {
    try {
      await syncOpenPerformanceTasksForUser({
        telegramUserId: user.telegram_user_id,
        username: user.username,
        configs: performanceConfigs,
      });
    } catch (error) {
      errors.push(`sync ${user.telegram_user_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Fixed workday cadence: 09:00 / 13:00 / 16:00 / 19:00.
  for (const user of users) {
    try {
      scheduledPushes += await sendScheduledPushes(user, now);
    } catch (error) {
      errors.push(`schedule ${user.telegram_user_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // In-progress tasks: no ordinary pushes. One check-in 2h after start; "still working" schedules the next one.
  try {
    const dueFollowups = await listActiveTasksForFollowup(now.toISOString());
    for (const task of dueFollowups) {
      const user = userMap.get(task.owner_telegram_user_id);
      if (!user?.reminders_enabled) continue;
      try {
        followups += await sendInProgressFollowup(task, user);
      } catch (error) {
        errors.push(`followup #${task.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    errors.push(`followup query: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Deadline-specific nudges remain higher priority for NEW tasks.
  const twoHourStart = new Date(now.getTime() + 110 * 60_000).toISOString();
  const twoHourEnd = new Date(now.getTime() + 130 * 60_000).toISOString();
  const dueStart = new Date(now.getTime() - 10 * 60_000).toISOString();
  const overdueCutoff = new Date(now.getTime() - 120 * 60_000).toISOString();

  const [twoHourTasks, dueTasks, overdueTasks] = await Promise.all([
    listActiveTasksDueBetween(twoHourStart, twoHourEnd),
    listActiveTasksDueBetween(dueStart, now.toISOString()),
    listActiveTasksDueBefore(overdueCutoff),
  ]);

  for (const task of twoHourTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_2h_at) continue;
    try { reminders += await sendTaskDeadlineReminder(task, "2h", user); }
    catch (error) { errors.push(`2h #${task.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  for (const task of dueTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_due_at) continue;
    try { reminders += await sendTaskDeadlineReminder(task, "due", user); }
    catch (error) { errors.push(`due #${task.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  for (const task of overdueTasks) {
    const user = userMap.get(task.owner_telegram_user_id);
    if (!user?.reminders_enabled || task.reminded_overdue_at) continue;
    try { reminders += await sendTaskDeadlineReminder(task, "overdue", user); }
    catch (error) { errors.push(`overdue #${task.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  return {
    users: users.length,
    scheduledPushes,
    followups,
    deadlineReminders: reminders,
    errors,
  };
}
