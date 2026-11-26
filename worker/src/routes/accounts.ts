import { Hono } from 'hono';
import type { Account } from '@mystock/shared';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, conflict, isForeignKeyError, notFound, parseId, validate } from '../lib/http';
import { accountCreate, accountUpdate, id } from '../lib/schemas';
import { assertCanReadUser, requireAdmin } from '../middleware/auth';

const app = new Hono<AppEnv>();

app.get('/', validate('query', z.object({ user_id: id.optional() })), async (c) => {
  const me = c.var.user;
  const { user_id } = c.req.valid('query');
  if (user_id !== undefined) assertCanReadUser(me, user_id);
  const target = me.role === 'admin' ? user_id : me.id;
  const stmt =
    target === undefined
      ? c.env.DB.prepare('SELECT * FROM accounts ORDER BY user_id, id')
      : c.env.DB.prepare('SELECT * FROM accounts WHERE user_id = ?1 ORDER BY id').bind(target);
  const { results } = await stmt.all<Account>();
  return c.json({ accounts: results });
});

app.post('/', requireAdmin, validate('json', accountCreate), async (c) => {
  const b = c.req.valid('json');
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(b.user_id).first();
  if (!user) badRequest('使用者不存在');
  const row = await c.env.DB.prepare(
    'INSERT INTO accounts (user_id, name, broker, currency) VALUES (?1, ?2, ?3, ?4) RETURNING *',
  )
    .bind(b.user_id, b.name, b.broker ?? null, b.currency)
    .first<Account>();
  return c.json({ account: row }, 201);
});

app.patch('/:id', requireAdmin, validate('json', accountUpdate), async (c) => {
  const accountId = parseId(c.req.param('id'));
  const b = c.req.valid('json');
  const row = await c.env.DB.prepare(
    `UPDATE accounts SET name = COALESCE(?2, name),
       broker = CASE WHEN ?3 THEN ?4 ELSE broker END
     WHERE id = ?1 RETURNING *`,
  )
    .bind(accountId, b.name ?? null, b.broker !== undefined ? 1 : 0, b.broker ?? null)
    .first<Account>();
  if (!row) notFound('找不到此帳戶');
  return c.json({ account: row });
});

app.delete('/:id', requireAdmin, async (c) => {
  const accountId = parseId(c.req.param('id'));
  try {
    const res = await c.env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(accountId).run();
    if (res.meta.changes === 0) notFound('找不到此帳戶');
  } catch (err) {
    if (isForeignKeyError(err)) conflict('此帳戶還有交易或定期定額，無法刪除');
    throw err;
  }
  return c.body(null, 204);
});

export default app;
