import { createApp } from './app';
import type { Env } from './env';
import { runDailyJob } from './jobs/daily';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runDailyJob(env, { fetch: (input, init) => fetch(input, init), now: new Date(controller.scheduledTime) }).then(
        (report) => console.log('daily job', controller.cron, JSON.stringify(report)),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
