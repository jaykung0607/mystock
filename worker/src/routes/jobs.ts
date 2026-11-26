import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { runDailyJob } from '../jobs/daily';
import { requireAdmin } from '../middleware/auth';

/** admin 手動觸發每日排程（例：第一次設定後回補、檢查資料源是否正常）。 */
const app = new Hono<AppEnv>();

app.post('/daily', requireAdmin, async (c) => {
  const report = await runDailyJob(c.env, { fetch: c.var.fetch, now: c.var.now(), twDelayMs: c.var.twDelayMs });
  return c.json({ report });
});

export default app;
