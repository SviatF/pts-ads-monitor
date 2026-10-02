// @ts-nocheck
import { default as handler } from "./.open-next/worker.js";

type Env = {
  CRON_SECRET: string;
  [key: string]: unknown;
};

function hydrateProcessEnv(env: Env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === "string") process.env[key] = value;
  }
}

function kyivClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(value.hour), minute: Number(value.minute), weekday: String(value.weekday || "") };
}

async function callInternal(path: string, env: Env, ctx: ExecutionContext) {
  const request = new Request(`https://pts-ads-monitor.internal${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
  const response = await handler.fetch(request, env, ctx);
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${body}`);
  console.log(`Scheduled ${path} completed`, body);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    hydrateProcessEnv(env);
    return handler.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    hydrateProcessEnv(env);
    const tasks: Promise<unknown>[] = [
      callInternal("/api/monitor", env, ctx),
      // Personal PTS Tasks bot: deadlines + morning/evening direct-message digests.
      // Cron already runs every 10 minutes, which is enough precision for task reminders.
      callInternal("/api/tasks-bot/reminders", env, ctx),
    ];
    const { hour, minute, weekday } = kyivClock();

    // Performance Control runs every 20 minutes (HH:00 / HH:20 / HH:40).
    // We intentionally run the full ruleset for now so fast checks cannot miss
    // a critical signal that lives deeper in the performance analysis.
    // Alert dedupe/cooldown is handled in DB, so repeated checks do not spam Telegram.
    if (minute < 10 || (minute >= 20 && minute < 30) || (minute >= 40 && minute < 50)) {
      tasks.push(callInternal("/api/performance/check", env, ctx));
    }

    // Management escalation: once per hour, offset from the performance check
    // so both heavier jobs are not started on the same cron tick.
    // Weekend filtering is handled by the endpoint.
    if (minute >= 30 && minute < 40) {
      tasks.push(callInternal("/api/performance/management?kind=escalations", env, ctx));
    }

    // At 07:00 Europe/Kyiv run lifecycle -> previous-day Meta sync -> Telegram status.
    if (hour === 7 && minute < 10) {
      tasks.push(callInternal("/api/reporting/morning", env, ctx));
    }

    // Daily Tasks: every day around 08:10 Europe/Kyiv.
    // On weekends the endpoint switches to a softer weekend message automatically.
    if (hour === 8 && minute >= 10 && minute < 20) {
      tasks.push(callInternal("/api/performance/tasks", env, ctx));
    }

    // Weekday afternoon reminder: only unfinished actionable tasks.
    if (hour === 15 && minute < 10 && weekday !== "Sat" && weekday !== "Sun") {
      tasks.push(callInternal("/api/performance/tasks?kind=reminder", env, ctx));
    }

    // Internal team briefs: morning priorities + end-of-day accountability.
    if (hour === 10 && minute < 10) {
      tasks.push(callInternal("/api/performance/brief?kind=morning", env, ctx));
    }
    if (hour === 19 && minute < 10) {
      tasks.push(callInternal("/api/performance/brief?kind=evening", env, ctx));
    }

    // Monday management scorecard + recurring-problem detector.
    if (weekday === "Mon" && hour === 10 && minute >= 10 && minute < 20) {
      tasks.push(callInternal("/api/performance/management?kind=weekly", env, ctx));
    }

    ctx.waitUntil(Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("Scheduled task failed", result.reason);
      }
    }));
  },
};
