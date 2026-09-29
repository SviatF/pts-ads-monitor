// @ts-nocheck
import { default as handler } from "./.open-next/worker.js";

type Env = {
  CRON_SECRET: string;
  [key: string]: unknown;
};

function hydrateProcessEnv(env: Env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    hydrateProcessEnv(env);
    return handler.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    hydrateProcessEnv(env);

    const request = new Request("https://pts-ads-monitor.internal/api/monitor", {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.CRON_SECRET}`,
      },
    });

    ctx.waitUntil(
      handler.fetch(request, env, ctx).then(async (response: Response) => {
        if (!response.ok) {
          const body = await response.text();
          console.error("Scheduled monitor failed", response.status, body);
          return;
        }

        const body = await response.text();
        console.log("Scheduled monitor completed", body);
      })
    );
  },
};
