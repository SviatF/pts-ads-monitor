import type { PersonalTask, TaskBotUser } from "@/lib/personal-task-store";

type TaskBotSessionRow = {
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

async function request<T>(path: string): Promise<T> {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase task dashboard failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export type TaskUserDashboard = {
  user: TaskBotUser;
  active: PersonalTask[];
  completed: PersonalTask[];
  cancelled: PersonalTask[];
  overdue: PersonalTask[];
  dueToday: PersonalTask[];
  completedToday: PersonalTask[];
  recentCompleted: PersonalTask[];
  session: TaskBotSessionRow | null;
};

function localDateKey(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function getTaskManagerDashboardData() {
  const [users, tasks, sessions] = await Promise.all([
    request<TaskBotUser[]>("task_bot_users?select=*&order=updated_at.desc"),
    request<PersonalTask[]>("personal_tasks?select=*&order=updated_at.desc&limit=2000"),
    request<TaskBotSessionRow[]>("task_bot_sessions?select=*&order=updated_at.desc"),
  ]);

  const now = new Date();
  const sessionByUser = new Map(sessions.map((item) => [item.telegram_user_id, item]));

  const byUser = new Map<number, PersonalTask[]>();
  for (const task of tasks) {
    const rows = byUser.get(task.owner_telegram_user_id) || [];
    rows.push(task);
    byUser.set(task.owner_telegram_user_id, rows);
  }

  const userRows: TaskUserDashboard[] = users.map((user) => {
    const rows = byUser.get(user.telegram_user_id) || [];
    const timezone = user.timezone || "Europe/Kyiv";
    const today = localDateKey(now, timezone);
    const active = rows.filter((task) => task.status === "active");
    const completed = rows.filter((task) => task.status === "completed");
    const cancelled = rows.filter((task) => task.status === "cancelled");
    const overdue = active.filter((task) => task.due_at && new Date(task.due_at).getTime() < now.getTime());
    const dueToday = active.filter((task) => task.due_at && localDateKey(new Date(task.due_at), timezone) === today);
    const completedToday = completed.filter((task) => task.completed_at && localDateKey(new Date(task.completed_at), timezone) === today);
    const recentCompleted = completed
      .slice()
      .sort((a, b) => new Date(b.completed_at || b.updated_at).getTime() - new Date(a.completed_at || a.updated_at).getTime())
      .slice(0, 6);

    return {
      user,
      active: active.slice().sort((a, b) => {
        if (!a.due_at && !b.due_at) return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
      }),
      completed,
      cancelled,
      overdue,
      dueToday,
      completedToday,
      recentCompleted,
      session: sessionByUser.get(user.telegram_user_id) || null,
    };
  });

  const allActive = tasks.filter((task) => task.status === "active");
  const allCompleted = tasks.filter((task) => task.status === "completed");
  const allOverdue = allActive.filter((task) => task.due_at && new Date(task.due_at).getTime() < now.getTime());
  const completedToday = allCompleted.filter((task) => {
    const user = users.find((item) => item.telegram_user_id === task.owner_telegram_user_id);
    const timezone = user?.timezone || "Europe/Kyiv";
    return Boolean(task.completed_at && localDateKey(new Date(task.completed_at), timezone) === localDateKey(now, timezone));
  });

  return {
    users: userRows,
    totals: {
      users: users.length,
      active: allActive.length,
      overdue: allOverdue.length,
      completedToday: completedToday.length,
      completedAll: allCompleted.length,
    },
    tasks,
  };
}
