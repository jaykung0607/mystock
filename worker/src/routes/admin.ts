import { Hono } from 'hono';
import type { User } from '@mystock/shared';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, validate } from '../lib/http';
import { decimal } from '../lib/schemas';
import { requireAdmin } from '../middleware/auth';

/** /api/users、/api/settings：都只有 admin 可用。 */
const app = new Hono<AppEnv>();

app.get('/users', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, display_name, role, can_submit_pending, created_at FROM users ORDER BY id',
  ).all<Omit<User, 'can_submit_pending'> & { can_submit_pending: number }>();
  return c.json({ users: results.map((u) => ({ ...u, can_submit_pending: u.can_submit_pending === 1 })) });
});

/** 允許修改的設定與其格式。 */
const SETTING_SCHEMAS: Record<string, z.ZodType<string>> = {
  tw_fee_rate: decimal,
  tw_fee_discount: decimal,
  tw_fee_min: decimal,
  tw_stock_tax_rate: decimal,
  tw_etf_tax_rate: decimal,
};

app.get('/settings', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all<{
    key: string;
    value: string;
  }>();
  return c.json({ settings: Object.fromEntries(results.map((r) => [r.key, r.value])) });
});

app.put('/settings', requireAdmin, validate('json', z.record(z.string(), z.unknown())), async (c) => {
  const body = c.req.valid('json');
  const stmts: D1PreparedStatement[] = [];
  for (const [key, raw] of Object.entries(body)) {
    const schema = SETTING_SCHEMAS[key];
    if (!schema) badRequest(`不支援的設定：${key}`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) badRequest(`${key} 格式錯誤`);
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).bind(key, parsed.data),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const { results } = await c.env.DB.prepare('SELECT key, value FROM settings ORDER BY key').all<{
    key: string;
    value: string;
  }>();
  return c.json({ settings: Object.fromEntries(results.map((r) => [r.key, r.value])) });
});

export default app;
