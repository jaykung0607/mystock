import { Hono } from 'hono';
import {
  summarizePositions,
  type FamilyPortfolioResponse,
  type PortfolioResponse,
  type User,
} from '@mystock/shared';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound, validate } from '../lib/http';
import { id } from '../lib/schemas';
import { assertCanReadUser, requireAdmin } from '../middleware/auth';
import { loadPortfolios } from '../services/portfolio';

const app = new Hono<AppEnv>();

/** 個人帳本：未指定 user_id 時為自己。 */
app.get('/', validate('query', z.object({ user_id: id.optional() })), async (c) => {
  const me = c.var.user;
  const userId = c.req.valid('query').user_id ?? me.id;
  assertCanReadUser(me, userId);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first();
  if (!exists) notFound('找不到此使用者');
  const portfolio = (await loadPortfolios(c.env.DB, [userId])).get(userId)!;
  return c.json<PortfolioResponse>(portfolio);
});

/** 全家合計（admin）。 */
app.get('/family', requireAdmin, async (c) => {
  const { results: users } = await c.env.DB.prepare(
    'SELECT id, display_name, role FROM users ORDER BY id',
  ).all<Pick<User, 'id' | 'display_name' | 'role'>>();
  const portfolios = await loadPortfolios(
    c.env.DB,
    users.map((u) => u.id),
  );
  const all = [...portfolios.values()].flatMap((p) =>
    p.positions.filter((x) => x.state).map((x) => ({ state: x.state!, valuation: x.valuation })),
  );
  return c.json<FamilyPortfolioResponse>({
    users: users.map((u) => ({ user: u, summary: portfolios.get(u.id)!.summary })),
    summary: summarizePositions(all),
  });
});

export default app;
