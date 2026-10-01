import { listPerformanceMonitoringConfigs } from "@/lib/performance-config-store";
import { escapeTelegramHtml, sendTelegramToChat } from "@/lib/invoice-telegram";

type AlertRow = {
  id: number;
  meta_account_id: string;
  alert_type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
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

async function request<T>(path: string): Promise<T> {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Performance tasks request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function taskChatId() {
  const chatId = process.env.TASKS_TELEGRAM_CHAT_ID?.trim() || "";
  if (!chatId) throw new Error("TASKS_TELEGRAM_CHAT_ID is not configured");
  return chatId;
}

function kyivDateKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function isWeekend() {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", weekday: "short" }).format(new Date());
  return day === "Sat" || day === "Sun";
}

function cleanUsername(value: string | null | undefined) {
  if (!value) return "";
  const clean = value.trim().replace(/^@/, "");
  return clean ? `@${escapeTelegramHtml(clean)}` : "";
}

function diagnosisReason(alert: AlertRow) {
  const diagnosis = alert.details?.diagnosis;
  if (!diagnosis || typeof diagnosis !== "object" || Array.isArray(diagnosis)) return "";
  const reason = (diagnosis as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason.toLowerCase() : "";
}

function recommendedAction(alert: AlertRow) {
  const type = alert.alert_type.toUpperCase();
  const reason = diagnosisReason(alert);

  if (type.includes("SPEND_WITHOUT_RESULTS")) return "Перевір delivery + result event. Якщо tracking ок — зупини/обмеж джерело spend без результатів.";
  if (type.includes("CREATIVE_WASTE")) return "Перевір цей creative. Якщо витрата вже ≥3× нормального CPL і 0 results — pause або заміни.";
  if (type.includes("CREATIVE_FATIGUE")) return "Онови hook/visual/copy або rotation; перед зміною звір fatigue в Ads Manager.";
  if (type.includes("ADSET")) return "Перевір цей ad set. Якщо waste підтверджений — обмеж бюджет/перерозподіли, не вирівнюй CBO вручну.";
  if (type.includes("PERFORMANCE_INCIDENT")) {
    if (reason.includes("креатив") || reason.includes("creative")) return "Почни з creatives: знайди слабкі hooks/ads і підготуй refresh. Landing без CR-сигналу не чіпай.";
    if (reason.includes("ленд") || reason.includes("форма") || reason.includes("tracking")) return "Перевір landing/form/event tracking і post-click quality; creative не змінюй без окремого сигналу.";
    if (reason.includes("аукціон") || reason.includes("auction")) return "Звір CPM. Якщо CTR/CR стабільні — не роби різких правок; перевір budget/audience/auction context.";
    return "Звір Recent 3d vs baseline і сьогоднішній recovery; внеси тільки точкову зміну по підтвердженій причині.";
  }
  return "Відкрий alert у Performance OS, звір причину й зроби точкову корекцію без зайвих змін у кампанії.";
}

function isActionable(alert: AlertRow) {
  return !alert.resolved_at && !SUPPRESSED_TYPES.has(alert.alert_type) && (alert.severity === "critical" || alert.severity === "action_required");
}

async function loadData() {
  const [alertsRaw, configs] = await Promise.all([
    request<AlertRow[]>("performance_alerts?select=id,meta_account_id,alert_type,severity,title,details,acknowledged_at,resolved_at&resolved_at=is.null&severity=in.(critical,action_required)&order=last_seen_at.desc&limit=300"),
    listPerformanceMonitoringConfigs(),
  ]);
  return { alerts: alertsRaw.filter(isActionable), configs: configs.filter((c) => c.enabled) };
}

async function sendGrouped(reminder: boolean) {
  const chatId = taskChatId();
  const { alerts, configs } = await loadData();
  const weekend = isWeekend();
  if (reminder && weekend) return { tasks: 0, targetologists: 0, skipped: "weekend" };

  const configByAccount = new Map(configs.map((c) => [c.meta_account_id, c]));
  const grouped = new Map<string, AlertRow[]>();
  for (const alert of alerts) {
    const config = configByAccount.get(alert.meta_account_id);
    if (!config) continue;
    const owner = config.targetologist_telegram?.trim() || "__unassigned__";
    const rows = grouped.get(owner) || [];
    rows.push(alert);
    grouped.set(owner, rows);
  }

  if (!reminder) {
    await sendTelegramToChat(chatId, `${weekend ? "🏖" : "☀️"} <b>PTS TASKS · ${escapeTelegramHtml(kyivDateKey())}</b>\n\n${weekend ? "Вихідний режим: нижче тільки те, що реально лишається на контролі." : "Коротко: проблема → що зробити → ACK/Done."}`);
  } else if (alerts.length) {
    await sendTelegramToChat(chatId, "👀 <b>ДЕННИЙ CHECK-IN</b>\n\nЛишаю тільки незакриті задачі. Якщо вже виконано — <code>/perf_done ID</code>.");
  }

  if (!alerts.length) {
    if (!reminder && !weekend) await sendTelegramToChat(chatId, "🟢 <b>Активних Action Required / Critical задач немає.</b>");
    return { tasks: 0, targetologists: 0, weekend };
  }

  const projectNames = new Map(configs.map((c) => [c.meta_account_id, c.project_name]));
  for (const [owner, rows] of grouped) {
    rows.sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
    const lines = rows.map((alert, index) => {
      const project = projectNames.get(alert.meta_account_id) || alert.meta_account_id;
      const icon = alert.severity === "critical" ? "🔴" : "🟠";
      const state = alert.acknowledged_at ? "✅ в роботі" : "⏳ не взято";
      const command = alert.acknowledged_at ? `/perf_done ${alert.id}` : `/perf_ack ${alert.id}`;
      return `${index + 1}. ${icon} <b>${escapeTelegramHtml(project)}</b> · ${state}\n${escapeTelegramHtml(alert.title)}\n👉 <b>Що зробити:</b> ${escapeTelegramHtml(recommendedAction(alert))}\n<code>${command}</code> · Alert #<code>${alert.id}</code>`;
    });
    const mention = owner === "__unassigned__" ? "⚠️ <b>Без відповідального</b>" : `<b>${cleanUsername(owner)}</b>`;
    await sendTelegramToChat(chatId, `👤 ${mention}\n\n${lines.join("\n\n")}`);
  }

  return { tasks: alerts.length, targetologists: grouped.size, weekend };
}

export async function sendDailyPerformanceTasks() {
  return sendGrouped(false);
}

export async function sendUnfinishedTaskReminder() {
  return sendGrouped(true);
}
