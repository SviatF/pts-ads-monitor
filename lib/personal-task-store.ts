export type TaskBotUser = {
  telegram_user_id: number;
  telegram_chat_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string;
  morning_digest_time: string;
  evening_digest_time: string;
  reminders_enabled: boolean;
  morning_digest_enabled: boolean;
  evening_digest_enabled: boolean;
  last_morning_digest_date: string | null;
  last_evening_digest_date: string | null;
  role: "member" | "manager";
  created_at: string;
  updated_at: string;
};

export type PersonalTask = {
  id: number;
  owner_telegram_user_id: number;
  created_by_telegram_user_id: number;
  title: string;
  project_name: string | null;
  notes: string | null;
  priority: "high" | "normal" | "low";
  status: "active" | "completed" | "cancelled";
  due_at: string | null;
  recurrence_rule: string | null;
  source_type: "self" | "performance" | "manager" | "team";
  performance_alert_id: number | null;
  assigned_by_label: string | null;
  reminded_2h_at: string | null;
  reminded_due_at: string | null;
  reminded_overdue_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskBotSession = {
  telegram_user_id: number;
  state: string;
  payload: Record<string, unknown>;
  updated_at: string;
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return { url, key };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, key } = config();
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
  if (!response.ok) throw new Error(`Supabase personal tasks request failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function upsertTaskBotUser(input: {
  telegramUserId: number;
  telegramChatId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const rows = await request<TaskBotUser[]>("task_bot_users?on_conflict=telegram_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      telegram_user_id: input.telegramUserId,
      telegram_chat_id: input.telegramChatId,
      username: input.username || null,
      first_name: input.firstName || null,
      last_name: input.lastName || null,
      updated_at: new Date().toISOString(),
    }),
  });
  return rows[0] || null;
}

export async function listTaskBotUsers() {
  return request<TaskBotUser[]>("task_bot_users?select=*&order=telegram_user_id.asc");
}

export async function getTaskBotUser(telegramUserId: number) {
  const rows = await request<TaskBotUser[]>(`task_bot_users?select=*&telegram_user_id=eq.${telegramUserId}&limit=1`);
  return rows[0] || null;
}

export async function findTaskBotUserByUsername(username: string) {
  const clean = username.trim().replace(/^@/, "").toLowerCase();
  if (!clean) return null;
  const rows = await request<TaskBotUser[]>(`task_bot_users?select=*&username=ilike.${encodeURIComponent(clean)}&limit=1`);
  return rows[0] || null;
}

export async function updateTaskBotUser(telegramUserId: number, patch: Partial<TaskBotUser>) {
  const rows = await request<TaskBotUser[]>(`task_bot_users?telegram_user_id=eq.${telegramUserId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return rows[0] || null;
}

export async function getTaskBotSession(telegramUserId: number) {
  const rows = await request<TaskBotSession[]>(`task_bot_sessions?select=*&telegram_user_id=eq.${telegramUserId}&limit=1`);
  return rows[0] || null;
}

export async function setTaskBotSession(telegramUserId: number, state: string, payload: Record<string, unknown> = {}) {
  const rows = await request<TaskBotSession[]>("task_bot_sessions?on_conflict=telegram_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      telegram_user_id: telegramUserId,
      state,
      payload,
      updated_at: new Date().toISOString(),
    }),
  });
  return rows[0] || null;
}

export async function clearTaskBotSession(telegramUserId: number) {
  await request(`task_bot_sessions?telegram_user_id=eq.${telegramUserId}`, { method: "DELETE" });
}

export async function createPersonalTask(input: {
  ownerTelegramUserId: number;
  createdByTelegramUserId: number;
  title: string;
  projectName?: string | null;
  notes?: string | null;
  priority?: "high" | "normal" | "low";
  dueAt?: string | null;
  sourceType?: "self" | "performance" | "manager" | "team";
  performanceAlertId?: number | null;
  assignedByLabel?: string | null;
}) {
  const rows = await request<PersonalTask[]>("personal_tasks", {
    method: "POST",
    body: JSON.stringify({
      owner_telegram_user_id: input.ownerTelegramUserId,
      created_by_telegram_user_id: input.createdByTelegramUserId,
      title: input.title,
      project_name: input.projectName || null,
      notes: input.notes || null,
      priority: input.priority || "normal",
      status: "active",
      due_at: input.dueAt || null,
      source_type: input.sourceType || "self",
      performance_alert_id: input.performanceAlertId || null,
      assigned_by_label: input.assignedByLabel || null,
    }),
  });
  return rows[0] || null;
}

export async function getPersonalTaskByPerformanceAlertId(alertId: number) {
  const rows = await request<PersonalTask[]>(`personal_tasks?select=*&performance_alert_id=eq.${alertId}&limit=1`);
  return rows[0] || null;
}

export async function getPersonalTask(taskId: number, ownerTelegramUserId?: number) {
  const ownerFilter = ownerTelegramUserId ? `&owner_telegram_user_id=eq.${ownerTelegramUserId}` : "";
  const rows = await request<PersonalTask[]>(`personal_tasks?select=*&id=eq.${taskId}${ownerFilter}&limit=1`);
  return rows[0] || null;
}

export async function updatePersonalTask(taskId: number, ownerTelegramUserId: number, patch: Partial<PersonalTask>) {
  const rows = await request<PersonalTask[]>(`personal_tasks?id=eq.${taskId}&owner_telegram_user_id=eq.${ownerTelegramUserId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return rows[0] || null;
}

export async function listPersonalTasks(input: {
  ownerTelegramUserId: number;
  status?: "active" | "completed" | "cancelled";
  limit?: number;
}) {
  const status = input.status || "active";
  const limit = Math.max(1, Math.min(50, input.limit || 20));
  return request<PersonalTask[]>(
    `personal_tasks?select=*&owner_telegram_user_id=eq.${input.ownerTelegramUserId}&status=eq.${status}&order=due_at.asc.nullslast,created_at.desc&limit=${limit}`
  );
}

export async function listActiveTasksDueBefore(iso: string) {
  return request<PersonalTask[]>(
    `personal_tasks?select=*&status=eq.active&due_at=not.is.null&due_at=lte.${encodeURIComponent(iso)}&order=due_at.asc&limit=500`
  );
}

export async function listActiveTasksDueBetween(startIso: string, endIso: string) {
  return request<PersonalTask[]>(
    `personal_tasks?select=*&status=eq.active&due_at=gte.${encodeURIComponent(startIso)}&due_at=lte.${encodeURIComponent(endIso)}&order=due_at.asc&limit=500`
  );
}

export function localDateKey(date: Date, timezone = "Europe/Kyiv") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function localClock(date: Date, timezone = "Europe/Kyiv") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(map.hour), minute: Number(map.minute) };
}

function timezoneOffsetMinutes(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(date);
  const name = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

export function localDateTimeToIso(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone?: string;
}) {
  const timezone = input.timezone || "Europe/Kyiv";
  const guess = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute));
  const offset = timezoneOffsetMinutes(guess, timezone);
  return new Date(guess.getTime() - offset * 60_000).toISOString();
}

export function taskDueLabel(dueAt: string | null, timezone = "Europe/Kyiv") {
  if (!dueAt) return "Без дедлайну";
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dueAt));
}

export function parseCustomDeadline(value: string, timezone = "Europe/Kyiv") {
  const clean = value.trim();
  const now = new Date();
  const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now));
  let match = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(clean);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3] || currentYear);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const iso = localDateTimeToIso({ year, month, day, hour, minute, timezone });
  return new Date(iso).getTime() > Date.now() - 60_000 ? iso : null;
}
