import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

type AlertRow = {
  id: number;
  meta_account_id: string;
  alert_key: string;
  alert_type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

const SUPPRESSED_TYPES = new Set(["CAMPAIGN_WASTE", "A_LEAD_DROP"]);

function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase operations request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function taskChatId() {
  return process.env.TASKS_TELEGRAM_CHAT_ID?.trim() || "";
}

function managementChatId() {
  return process.env.MANAGEMENT_TELEGRAM_CHAT_ID?.trim() || "";
}

function cleanUsername(value: string | null | undefined) {
  if (!value) return "";
  const clean = value.trim().replace(/^@/, "");
  return clean ? `@${escapeTelegramHtml(clean)}` : "";
}

function isActionable(alert: AlertRow) {
  return !SUPPRESSED_TYPES.has(alert.alert_type) && (alert.severity === "critical" || alert.severity === "action_required");
}

function kyivDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function kyivWeekday() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", weekday: "short" }).format(new Date());
}

function isWeekend() {
  const day = kyivWeekday();
  return day === "Sat" || day === "Sun";
}

function pickDaily(variants: string[]) {
  const key = kyivDateKey().replace(/-/g, "");
  return variants[Number(key.slice(-4)) % variants.length];
}

function greetingForToday() {
  return pickDaily([
    "Доброго ранку 😈 Знаю, ви мене не любите, але кабінети вже прокинулись і принесли нам задачі. Розбираємо сьогодні — і живемо спокійно.",
    "Доброго ранку ☕ Я знову прийшов псувати вам каву цифрами. Хороша новина: список задач уже готовий, залишилось тільки закрити його сьогодні.",
    "Ранок добрий 😎 Кабінети вночі без нас не нудьгували, тому маємо кілька моментів на сьогодні. Без паніки — просто йдемо по списку.",
    "Всім доброго ранку 🚀 Ваш улюблений бот знову тут. Так, знаю, любов взаємна. Нижче тільки те, що реально потрібно розібрати сьогодні.",
    "Доброго ранку 👀 Поки ви відкривали Telegram, я вже полазив по кабінетах. Є кілька задач. Закриваємо їх — і я від вас відчеплюсь. Можливо.",
    "Morning, team 🫡 Сьогодні без мотиваційних цитат. Є кабінети, є цифри, є задачі. Все чесно. Поїхали.",
    "Доброго ранку 🧠 Я перевірив кабінети, щоб вам не довелось починати день з 48 вкладок Ads Manager. Нижче ваш персональний список.",
    "Всім привіт 🌚 Так, це знову я. Ні, вимкнути мене не можна. Але можна швидко закрити задачі нижче й більше мене сьогодні не бачити.",
  ]);
}

function weekendGreeting(hasTasks: boolean) {
  const intro = pickDaily([
    "Сьогодні вихідний 😴 Я теж планував мовчати, але спочатку перевірив кабінети. Професійна деформація, нічого не поробиш.",
    "Вихідний 🏖 Ads Manager сьогодні офіційно не головний екран вашого телефону. Відпочивайте — ви це заслужили.",
    "Доброго ранку ☕ Сьогодні вихідний. Бот урочисто дозволяє не відкривати 48 вкладок з рекламою.",
    "Weekend mode activated 😎 Сьогодні без гонки, без дедлайнів і бажано без фрази «я тільки на хвилинку зайду в кабінет».",
    "Сьогодні вихідний 🛌 Я прийшов не псувати настрій, а нагадати: іноді performance росте навіть тоді, коли таргетолог відпочиває 😄",
  ]);
  return hasTasks
    ? `${intro}\n\nЄ кілька моментів, які залишаються на контролі. <b>Як будете мати вільний час — гляньте, будь ласка.</b> Без режиму «терміново все кидати».`
    : `${intro}\n\n🟢 Нічого критичного не горить. Відпочивайте спокійно — сьогодні я від вас відчеплюсь.`;
}

function severityIcon(alert: AlertRow) {
  return alert.severity === "critical" ? "🔴" : "🟠";
}

function groupTasks(alerts: AlertRow[], configs: Awaited<ReturnType<typeof listPerformanceMonitoringConfigs>>) {
  const configByAccount = new Map(configs.filter((c) => c.enabled).map((c) => [c.meta_account_id, c]));
  const grouped = new Map<string, AlertRow[]>();
  for (const alert of alerts) {
    const config = configByAccount.get(alert.meta_account_id);
    if (!config) continue;
    const owner = config.targetologist_telegram?.trim() || "__unassigned__";
    const rows = grouped.get(owner) || [];
    rows.push(alert);
    grouped.set(owner, rows);
  }
  return grouped;
}

async function sendGroupedTasks(chatId: string, grouped: Map<string, AlertRow[]>, configs: Awaited<ReturnType<typeof listPerformanceMonitoringConfigs>>, weekend: boolean, reminder = false) {
  const configNames = new Map(configs.map((c) => [c.meta_account_id, c.project_name]));
  for (const [owner, rows] of grouped) {
    rows.sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
    const lines = rows.map((alert, index) => {
      const project = configNames.get(alert.meta_account_id) || alert.meta_account_id;
      const status = alert.acknowledged_at ? "✅ вже в роботі" : "⏳ ще не взято";
      return `${index + 1}. ${severityIcon(alert)} <b>${escapeTelegramHtml(project)}</b>\n   ${escapeTelegramHtml(alert.title)} · ${status}\n   Alert #<code>${alert.id}</code> · закриття у персональному <b>PTS Tasks</b>`;
    });
    const mention = owner === "__unassigned__" ? "⚠️ <b>Без призначеного таргетолога</b>" : `<b>${cleanUsername(owner)}</b>`;
    const heading = reminder ? "Ще залишилось на сьогодні:" : weekend ? "На контролі у вихідний:" : "Задачі по кабінетах на сьогодні:";
    const footer = reminder
      ? "Якщо задача вже вирішена — відкрийте персональний <b>PTS Tasks</b> і натисніть «✅ Виконано»."
      : weekend
        ? "Як буде зручно — перегляньте у персональному <b>PTS Tasks</b>. Закриття задачі робимо тільки там."
        : "Усі ці задачі вже підтягуються в персональний <b>PTS Tasks</b>. Після виконання натисніть там «✅ Виконано» — alert закриється автоматично.";
    await sendTelegramToChat(chatId, `👤 ${mention}\n\n<b>${heading}</b>\n\n${lines.join("\n\n")}\n\n${footer}`);
  }
}

export async function sendDailyPerformanceTasks() {
  const chatId = taskChatId();
  if (!chatId) throw new Error("TASKS_TELEGRAM_CHAT_ID is not configured");

  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>("performance_alerts?select=*&resolved_at=is.null&severity=in.(critical,action_required)&order=last_seen_at.desc&limit=300"),
    listPerformanceMonitoringConfigs(),
  ]);
  const alerts = alertsRaw.filter(isActionable);
  const weekend = isWeekend();
  const grouped = groupTasks(alerts, configs);

  await sendTelegramToChat(
    chatId,
    `${weekend ? "🏖" : "☀️"} <b>PTS TASKS · ${escapeTelegramHtml(kyivDateKey())}</b>\n\n${weekend ? weekendGreeting(alerts.length > 0) : greetingForToday()}`,
  );

  if (!alerts.length) {
    if (!weekend) {
      await sendTelegramToChat(chatId, "🟢 <b>Сьогодні активних Action Required / Critical задач немає.</b>\n\nНасолоджуйтесь моментом. Бот теж здивований 😄");
    }
    return { tasks: 0, targetologists: 0, weekend };
  }

  await sendGroupedTasks(chatId, grouped, configs, weekend, false);
  return { tasks: alerts.length, targetologists: grouped.size, weekend };
}

export async function sendUnfinishedTaskReminder() {
  if (isWeekend()) return { tasks: 0, targetologists: 0, skipped: "weekend" };
  const chatId = taskChatId();
  if (!chatId) throw new Error("TASKS_TELEGRAM_CHAT_ID is not configured");

  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>("performance_alerts?select=*&resolved_at=is.null&severity=in.(critical,action_required)&order=last_seen_at.desc&limit=300"),
    listPerformanceMonitoringConfigs(),
  ]);
  const alerts = alertsRaw.filter(isActionable);
  if (!alerts.length) return { tasks: 0, targetologists: 0 };

  const grouped = groupTasks(alerts, configs);
  await sendTelegramToChat(chatId, "👀 <b>ДЕННИЙ CHECK-IN</b>\n\nНагадую тільки про те, що ще не закрито. Виконані задачі закриваємо у персональному <b>PTS Tasks</b> кнопкою «✅ Виконано» 😄");
  await sendGroupedTasks(chatId, grouped, configs, false, true);
  return { tasks: alerts.length, targetologists: grouped.size };
}

export async function notifyPerformanceTaskCompleted(alert: AlertRow) {
  const chatId = taskChatId();
  if (!chatId) return 0;
  const configs = await listPerformanceMonitoringConfigs();
  const config = configs.find((item) => item.meta_account_id === alert.meta_account_id);
  const project = config?.project_name || alert.meta_account_id;
  const owner = cleanUsername(config?.targetologist_telegram);
  await sendTelegramToChat(
    chatId,
    `✅ <b>ЗАДАЧУ ЗАКРИТО</b>\n\nПроєкт: <b>${escapeTelegramHtml(project)}</b>\nПроблема: ${escapeTelegramHtml(alert.title)}${owner ? `\nТаргетолог: ${owner}` : ""}\nAlert: <code>#${alert.id}</code>\n\nДякую. По цій задачі бот офіційно відстав 😄`,
  );
  return 1;
}

export async function sendManagementEscalations() {
  const chatId = managementChatId();
  if (!chatId) return { sent: 0, skipped: "MANAGEMENT_TELEGRAM_CHAT_ID is not configured" };

  const weekend = isWeekend();
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const severityFilter = weekend ? "critical" : "critical,action_required";
  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>(`performance_alerts?select=*&resolved_at=is.null&acknowledged_at=is.null&severity=in.(${severityFilter})&last_notified_at=lte.${encodeURIComponent(cutoff)}&order=last_notified_at.asc&limit=100`),
    listPerformanceMonitoringConfigs(),
  ]);
  const configByAccount = new Map(configs.map((c) => [c.meta_account_id, c]));
  let sent = 0;

  for (const alert of alertsRaw.filter(isActionable)) {
    if (weekend && alert.severity !== "critical") continue;
    if (alert.details?.management_escalated_at) continue;
    const config = configByAccount.get(alert.meta_account_id);
    if (!config) continue;
    const ageHours = alert.last_notified_at ? Math.max(4, (Date.now() - new Date(alert.last_notified_at).getTime()) / 3600000) : 4;
    await sendTelegramToChat(
      chatId,
      `🚨 <b>MANAGEMENT ESCALATION</b>\n\nПроєкт: <b>${escapeTelegramHtml(config.project_name)}</b>\nТаргетолог: ${cleanUsername(config.targetologist_telegram) || "<b>не призначений</b>"}\nПроблема: <b>${escapeTelegramHtml(alert.title)}</b>\nAlert: <code>#${alert.id}</code>\nБез підтвердження: <b>${ageHours.toFixed(1)} год</b>${weekend ? "\n\n🏖 Сьогодні вихідний, тому ескалуємо тільки Critical." : "\n\nКоманда ще не взяла критичну/action-required задачу в роботу."}`,
    );
    await request(`performance_alerts?id=eq.${alert.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        details: { ...alert.details, management_escalated_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }),
    });
    sent += 1;
  }
  return { sent, weekend };
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function sendWeeklyTeamScorecard() {
  const chatId = managementChatId();
  if (!chatId) throw new Error("MANAGEMENT_TELEGRAM_CHAT_ID is not configured");
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>(`performance_alerts?select=*&first_seen_at=gte.${encodeURIComponent(since)}&order=first_seen_at.desc&limit=1000`),
    listPerformanceMonitoringConfigs(),
  ]);
  const alerts = alertsRaw.filter((a) => !SUPPRESSED_TYPES.has(a.alert_type));
  const byOwner = new Map<string, typeof configs>();
  for (const config of configs.filter((c) => c.enabled)) {
    const owner = config.targetologist_telegram?.trim() || "__unassigned__";
    const rows = byOwner.get(owner) || [];
    rows.push(config);
    byOwner.set(owner, rows);
  }

  const blocks: string[] = [];
  for (const [owner, ownerConfigs] of byOwner) {
    const ids = new Set(ownerConfigs.map((c) => c.meta_account_id));
    const rows = alerts.filter((a) => ids.has(a.meta_account_id) && isActionable(a));
    const acked = rows.filter((a) => a.acknowledged_at);
    const resolved = rows.filter((a) => a.resolved_at);
    const ackMinutes = acked.map((a) => (new Date(a.acknowledged_at as string).getTime() - new Date(a.first_seen_at).getTime()) / 60000).filter((v) => v >= 0 && Number.isFinite(v));
    const critical = rows.filter((a) => a.severity === "critical").length;
    blocks.push(
      `${owner === "__unassigned__" ? "⚠️ Без відповідального" : `<b>${cleanUsername(owner)}</b>`}\n` +
      `Проєктів: <b>${ownerConfigs.length}</b> · Actionable alerts: <b>${rows.length}</b> · Critical: <b>${critical}</b>\n` +
      `Взято в роботу: <b>${acked.length}/${rows.length}</b> · Закрито: <b>${resolved.length}/${rows.length}</b>\n` +
      `Median time to ACK: <b>${ackMinutes.length ? `${Math.round(median(ackMinutes))} хв` : "—"}</b>`,
    );
  }

  await sendTelegramToChat(chatId, `📊 <b>PTS TEAM CONTROL · 7 ДНІВ</b>\n\n${blocks.join("\n\n")}\n\nЦе операційний зріз для контролю реакції та закриття задач, а не рейтинг спеціалістів.`);
  return { targetologists: byOwner.size, alerts: alerts.length };
}

export async function sendRecurringProblemReport() {
  const chatId = managementChatId();
  if (!chatId) return { sent: 0 };
  const since = new Date(Date.now() - 10 * 86400000).toISOString();
  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>(`performance_alerts?select=*&first_seen_at=gte.${encodeURIComponent(since)}&order=first_seen_at.desc&limit=1000`),
    listPerformanceMonitoringConfigs(),
  ]);
  const names = new Map(configs.map((c) => [c.meta_account_id, c.project_name]));
  const buckets = new Map<string, AlertRow[]>();
  for (const alert of alertsRaw) {
    if (SUPPRESSED_TYPES.has(alert.alert_type) || alert.alert_type === "RECURRING_ISSUE" || alert.alert_type === "POST_OPTIMIZATION_CHECK") continue;
    const key = `${alert.meta_account_id}|${alert.alert_type}`;
    const rows = buckets.get(key) || [];
    rows.push(alert);
    buckets.set(key, rows);
  }

  let sent = 0;
  for (const [key, rows] of buckets) {
    if (rows.length < 3) continue;
    const [accountId, alertType] = key.split("|");
    const marker = `recurring:${accountId}:${alertType}:${kyivDateKey().slice(0, 7)}`;
    const existing = await request<Array<{ id: number }>>(`performance_alerts?select=id&meta_account_id=eq.${encodeURIComponent(accountId)}&alert_key=eq.${encodeURIComponent(marker)}&limit=1`);
    if (existing.length) continue;
    await sendTelegramToChat(
      chatId,
      `🔁 <b>ПОВТОРЮВАНА ПРОБЛЕМА</b>\n\nПроєкт: <b>${escapeTelegramHtml(names.get(accountId) || accountId)}</b>\nТип: <b>${escapeTelegramHtml(rows[0].title)}</b>\nЗа останні 10 днів: <b>${rows.length} окремих випадків</b>\n\nЦе вже схоже не на разовий incident. Варто переглянути сам підхід/процес, а не тільки точково гасити черговий alert.`,
    );
    await request("performance_alerts", {
      method: "POST",
      body: JSON.stringify({
        meta_account_id: accountId,
        alert_key: marker,
        alert_type: "RECURRING_ISSUE",
        severity: "warning",
        title: `Повторювана проблема: ${rows[0].title}`,
        details: { source_alert_type: alertType, occurrences: rows.length },
        last_seen_at: new Date().toISOString(),
        last_notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    sent += 1;
  }
  return { sent };
}
