import { Hono, type Context } from 'hono';
import {
  D,
  type Dec,
  OUT_DP,
  out,
  summarizePositions,
  type FamilyPortfolioResponse,
  type PortfolioHistoryResponse,
  type PortfolioResponse,
  type User,
} from '@mystock/shared';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { taipeiNow } from '../lib/dates';
import { notFound, validate } from '../lib/http';
import { date, id } from '../lib/schemas';
import { assertCanReadUser, requireAdmin } from '../middleware/auth';
import { loadPortfolios, type ValuationOptions } from '../services/portfolio';
import { getIntradayQuotes } from '../services/quotes';

const app = new Hono<AppEnv>();

/** live=1：交易時段內以盤中延遲報價評價（快取 5 分鐘），否則用最近收盤價。 */
const liveFlag = z.enum(['0', '1']).optional();

function valuationOptions(c: Context<AppEnv>, live: boolean): ValuationOptions {
  const now = c.var.now();
  return {
    today: taipeiNow(now).date,
    intraday: live ? (targets) => getIntradayQuotes(c.env, c.var.fetch, now, targets) : undefined,
  };
}

/** 個人帳本：未指定 user_id 時為自己。 */
app.get('/', validate('query', z.object({ user_id: id.optional(), live: liveFlag })), async (c) => {
  const me = c.var.user;
  const q = c.req.valid('query');
  const userId = q.user_id ?? me.id;
  assertCanReadUser(me, userId);
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first();
  if (!exists) notFound('找不到此使用者');
  const portfolio = (await loadPortfolios(c.env.DB, [userId], valuationOptions(c, q.live === '1'))).get(userId)!;
  return c.json<PortfolioResponse>(portfolio);
});

/** 全家合計（admin）。 */
app.get('/family', requireAdmin, validate('query', z.object({ live: liveFlag })), async (c) => {
  const { results: users } = await c.env.DB.prepare(
    'SELECT id, display_name, role FROM users ORDER BY id',
  ).all<Pick<User, 'id' | 'display_name' | 'role'>>();
  const portfolios = await loadPortfolios(
    c.env.DB,
    users.map((u) => u.id),
    valuationOptions(c, c.req.valid('query').live === '1'),
  );
  const all = [...portfolios.values()].flatMap((p) =>
    p.positions.filter((x) => x.state).map((x) => ({ state: x.state!, valuation: x.valuation })),
  );
  return c.json<FamilyPortfolioResponse>({
    users: users.map((u) => ({ user: u, summary: portfolios.get(u.id)!.summary })),
    summary: summarizePositions(all),
  });
});

/**
 * 資產走勢（每日快照）。user_id 省略：小孩為自己；admin 為全家合計。
 * 快照由每日排程寫入。
 */
app.get(
  '/history',
  validate('query', z.object({ user_id: id.optional(), from: date.optional(), to: date.optional() })),
  async (c) => {
    const me = c.var.user;
    const q = c.req.valid('query');
    const userId = q.user_id ?? (me.role === 'admin' ? null : me.id);
    if (userId !== null) assertCanReadUser(me, userId);
    const from = q.from ?? '0000-00-00';
    const to = q.to ?? '9999-99-99';
    const stmt =
      userId === null
        ? c.env.DB.prepare(
            'SELECT date, market_value_twd, cost_twd FROM portfolio_snapshots WHERE date >= ?1 AND date <= ?2 ORDER BY date',
          ).bind(from, to)
        : c.env.DB.prepare(
            `SELECT date, market_value_twd, cost_twd FROM portfolio_snapshots
             WHERE user_id = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date`,
          ).bind(userId, from, to);
    const { results } = await stmt.all<{ date: string; market_value_twd: string; cost_twd: string }>();
    // 全家合計：同一天各人相加（某人在該日還沒開始＝0）
    const byDate = new Map<string, { mv: Dec; cost: Dec }>();
    for (const r of results) {
      const cur = byDate.get(r.date) ?? { mv: D(0), cost: D(0) };
      byDate.set(r.date, { mv: cur.mv.plus(r.market_value_twd), cost: cur.cost.plus(r.cost_twd) });
    }
    const points = [...byDate].map(([d, v]) => ({
      date: d,
      market_value_twd: out(v.mv, OUT_DP.money),
      cost_twd: out(v.cost, OUT_DP.money),
    }));
    return c.json<PortfolioHistoryResponse>({ user_id: userId, points });
  },
);

export default app;
