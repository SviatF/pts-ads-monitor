// @ts-nocheck
import { default as handler } from "./.open-next/worker.js";

type Env = {
  CRON_SECRET: string;
  [key: string]: unknown;
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
