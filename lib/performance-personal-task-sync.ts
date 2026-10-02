import type { PerformanceMonitoringConfig } from "@/lib/performance-config-store";
import {
  createPersonalTask,
  findTaskBotUserByUsername,
  getPersonalTaskByPerformanceAlertId,
} from "@/lib/personal-task-store";
import { escapeTelegramHtml, sendTasksBotMessage, taskActionKeyboard } from "@/lib/tasks-bot-telegram";

type PerformanceAlertLike = {
  id: number;
  meta_account_id: string;
  alert_type: string;
  severity: string;
  title: string;
  resolved_at?: string | null;
};

function normalizeUsername(value: string | null | undefined) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function dueForSeverity(severity: string) {
  const hours = severity === "critical" ? 2 : 4;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function actionHint(alertType: string) {
  if (alertType.includes("SPEND_WITHOUT_RESULTS")) return "Перевір delivery/result event. Якщо tracking OK — зупини або обмеж джерело spend без результатів.";
  if (alertType.includes("CREATIVE_WASTE")) return "Перевір creative. Якщо waste підтверджений — вимкни/обмеж і перенеси бюджет у сильніші ads.";
  if (alertType.includes("CREATIVE_FATIGUE")) return "Перевір креативи та підготуй refresh: новий hook/visual/copy.";
  if (alertType.includes("ADSET_ISSUE")) return "Перевір ad set. Якщо waste підтверджений — обмеж бюджет/перерозподіли без ручного вирівнювання CBO.";
  if (alertType.includes("PERFORMANCE_INCIDENT")) return "Перевір diagnosis у Performance OS і зроби точкову оптимізацію по причині.";
  return "Перевір проблему в Performance OS і зафіксуй виконану дію.";
}

export async function ensurePerformanceAlertPersonalTask(
  config: PerformanceMonitoringConfig,
  alert: PerformanceAlertLike,
  options: { notifyUser?: boolean } = {},
) {
  if (!["critical", "action_required"].includes(alert.severity) || alert.resolved_at) return null;

  const username = normalizeUsername(config.targetologist_telegram);
  if (!username) return null;

  const owner = await findTaskBotUserByUsername(username);
  if (!owner) return null;

  const existing = await getPersonalTaskByPerformanceAlertId(alert.id);
  if (existing) return existing;

  const task = await createPersonalTask({
    ownerTelegramUserId: owner.telegram_user_id,
    createdByTelegramUserId: owner.telegram_user_id,
    title: alert.title,
    projectName: config.project_name,
    notes: actionHint(alert.alert_type),
    priority: alert.severity === "critical" ? "high" : "normal",
    dueAt: dueForSeverity(alert.severity),
    sourceType: "performance",
    performanceAlertId: alert.id,
    assignedByLabel: "PTS Performance OS",
  });

  if (task && options.notifyUser !== false) {
    await sendTasksBotMessage({
      chatId: owner.telegram_chat_id,
      text:
        `⚡ <b>НОВА PERFORMANCE-ЗАДАЧА</b>\n\n` +
        `Проєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\n` +
        `Задача: <b>${escapeTelegramHtml(alert.title)}</b>\n` +
        `👉 ${escapeTelegramHtml(actionHint(alert.alert_type))}\n\n` +
        `Alert #<code>${alert.id}</code> · закривається тут, без /perf_done.`,
      replyMarkup: taskActionKeyboard(task.id),
    });
  }

  return task;
}

export async function syncOpenPerformanceTasksForUser(input: {
  telegramUserId: number;
  username?: string | null;
  configs: PerformanceMonitoringConfig[];
}) {
  const username = normalizeUsername(input.username);
  if (!username) return { created: 0 };

  const matching = input.configs.filter((config) => normalizeUsername(config.targetologist_telegram) === username && config.enabled);
  if (!matching.length) return { created: 0 };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { created: 0 };

  let created = 0;
  for (const config of matching) {
    const response = await fetch(
      `${url}/rest/v1/performance_alerts?select=id,meta_account_id,alert_type,severity,title,resolved_at&meta_account_id=eq.${encodeURIComponent(config.meta_account_id)}&resolved_at=is.null&severity=in.(critical,action_required)&order=last_seen_at.desc&limit=50`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
    );
    if (!response.ok) continue;
    const alerts = await response.json() as PerformanceAlertLike[];
    for (const alert of alerts) {
      const before = await getPersonalTaskByPerformanceAlertId(alert.id);
      if (before) continue;
      const task = await ensurePerformanceAlertPersonalTask(config, alert, { notifyUser: false });
      if (task) created += 1;
    }
  }
  return { created };
}
