// @ts-nocheck
import { default as handler } from "./.open-next/worker.js";

type Env = {
  CRON_SECRET: string;
};

export default {
  fetch: handler.fetch,

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const request = new Request("https://pts-ads-monitor.internal/api/monitor", {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.CRON_SECRET}`,
      },
    });

    ctx.waitUntil(
      handler.fetch(request).then(async (response: Response) => {
        if (!response.ok) {
          const body = await response.text();
          console.error("Scheduled monitor failed", response.status, body);
        }
      })
    );
  },
};
