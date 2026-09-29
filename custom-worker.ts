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
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(value.hour), minute: Number(value.minute) };
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
    const tasks: Promise<unknown>[] = [callInternal("/api/monitor", env, ctx)];

    // Cron runs every 10 minutes. At 07:00 Europe/Kyiv run the complete reporting
    // morning workflow: lifecycle (monthly/new week) -> previous-day Meta sync -> Telegram status.
    const { hour, minute } = kyivClock();
    if (hour === 7 && minute < 10) {
      tasks.push(callInternal("/api/reporting/morning", env, ctx));
    }

    ctx.waitUntil(Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error("Scheduled task failed", result.reason);
      }
    }));
  },
};
