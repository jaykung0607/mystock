import { Hono } from 'hono';
import type { CalcTransaction, Instrument, Transaction } from '@mystock/shared';
import type { AppEnv } from '../env';
import { badRequest, notFound, parseId, validate } from '../lib/http';
import { assertCanReadUser, requireAdmin } from '../middleware/auth';
import { transactionCreate, transactionQuery, transactionUpdate } from '../lib/schemas';
import {
  assertPositionValid,
  fxLookup,
  loadFeeSettings,
  loadPositionTransactions,
  normalizeTransaction,
  type TxDraft,
  type TxValues,
} from '../services/transactions';

const app = new Hono<AppEnv>();

const SELECT_TX = `SELECT t.*, a.user_id FROM transactions t JOIN accounts a ON a.id = t.account_id`;

type TxWithUser = Transaction & { user_id: number };

async function getTx(db: D1Database, id: number): Promise<TxWithUser> {
  const row = await db.prepare(`${SELECT_TX} WHERE t.id = ?1`).bind(id).first<TxWithUser>();
  if (!row) notFound('找不到此交易');
  return row;
}

async function getInstrument(db: D1Database, id: number) {
  const row = await db
    .prepare('SELECT id, type, symbol, currency FROM instruments WHERE id = ?1')
    .bind(id)
    .first<Pick<Instrument, 'id' | 'type' | 'symbol' | 'currency'>>();
  if (!row) badRequest('標的不存在');
  return row;
}

function asCalc(id: number, v: TxValues): CalcTransaction {
  return { id, ...v };
}

// 列表：admin 可依 user/account 篩選；小孩只能看自己的
app.get('/', validate('query', transactionQuery), async (c) => {
  const q = c.req.valid('query');
  const me = c.var.user;
  const userId = me.role === 'admin' ? q.user_id : me.id;
  if (q.user_id !== undefined) assertCanReadUser(me, q.user_id);

  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, v: string | number) => {
    params.push(v);
    where.push(sql.replace('?', `?${params.length}`));
  };
  if (userId !== undefined) add('a.user_id = ?', userId);
  if (q.account_id !== undefined) add('t.account_id = ?', q.account_id);
  if (q.instrument_id !== undefined) add('t.instrument_id = ?', q.instrument_id);
  if (q.status !== undefined) add('t.status = ?', q.status);
  if (q.from !== undefined) add('t.trade_date >= ?', q.from);
  if (q.to !== undefined) add('t.trade_date <= ?', q.to);

  const sql = `${SELECT_TX}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.trade_date DESC, t.id DESC`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<TxWithUser>();
  return c.json({ transactions: results });
});

app.get('/:id', async (c) => {
  const tx = await getTx(c.env.DB, parseId(c.req.param('id')));
  assertCanReadUser(c.var.user, tx.user_id);
  return c.json({ transaction: tx });
});

app.post('/', requireAdmin, validate('json', transactionCreate), async (c) => {
  const body = c.req.valid('json');
  const db = c.env.DB;
  const account = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(body.account_id).first();
  if (!account) badRequest('帳戶不存在');
  const instrument = await getInstrument(db, body.instrument_id);

  const { account_id, instrument_id, ...draft } = body;
  const values = await normalizeTransaction(draft, {
    instrument,
    feeSettings: await loadFeeSettings(db),
    lookupFx: fxLookup(db),
  });

  const existing = await loadPositionTransactions(db, account_id, instrument_id);
  assertPositionValid([...existing, asCalc(Number.MAX_SAFE_INTEGER, values)]);

  const row = await db
    .prepare(
      `INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, price, amount, fee, tax,
         fx_rate, amount_twd, withholding_tax, split_ratio, note, status, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       RETURNING *`,
    )
    .bind(
      account_id,
      instrument_id,
      values.type,
      values.trade_date,
      values.quantity,
      values.price,
      values.amount,
      values.fee,
      values.tax,
      values.fx_rate,
      values.amount_twd,
      values.withholding_tax,
      values.split_ratio,
      values.note,
      values.status,
      c.var.user.id,
    )
    .first<Transaction>();
  return c.json({ transaction: row }, 201);
});

app.patch('/:id', requireAdmin, validate('json', transactionUpdate), async (c) => {
  const id = parseId(c.req.param('id'));
  const patch = c.req.valid('json');
  const db = c.env.DB;
  const current = await getTx(db, id);
  const instrument = await getInstrument(db, current.instrument_id);

  // 合併後整筆重新正規化。改了類型時，舊類型的欄位要能被清掉，所以以 patch 優先。
  const merged: TxDraft = {
    type: current.type,
    trade_date: current.trade_date,
    quantity: current.quantity,
    price: current.price,
    amount: current.amount,
    fee: current.fee,
    tax: current.tax,
    fx_rate: current.fx_rate,
    amount_twd: current.amount_twd,
    withholding_tax: current.withholding_tax,
    split_ratio: current.split_ratio,
    note: current.note,
    status: current.status,
    ...patch,
  };
  // 改了交易日但沒給匯率 → 依新日期重抓匯率
  if (patch.trade_date && patch.fx_rate === undefined && patch.trade_date !== current.trade_date) {
    merged.fx_rate = null;
  }
  const values = await normalizeTransaction(merged, {
    instrument,
    feeSettings: await loadFeeSettings(db),
    lookupFx: fxLookup(db),
  });

  const others = (await loadPositionTransactions(db, current.account_id, current.instrument_id)).filter(
    (t) => t.id !== id,
  );
  assertPositionValid([...others, asCalc(id, values)]);

  const row = await db
    .prepare(
      `UPDATE transactions SET type = ?2, trade_date = ?3, quantity = ?4, price = ?5, amount = ?6, fee = ?7,
         tax = ?8, fx_rate = ?9, amount_twd = ?10, withholding_tax = ?11, split_ratio = ?12, note = ?13,
         status = ?14, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 RETURNING *`,
    )
    .bind(
      id,
      values.type,
      values.trade_date,
      values.quantity,
      values.price,
      values.amount,
      values.fee,
      values.tax,
      values.fx_rate,
      values.amount_twd,
      values.withholding_tax,
      values.split_ratio,
      values.note,
      values.status,
    )
    .first<Transaction>();
  return c.json({ transaction: row });
});

app.delete('/:id', requireAdmin, async (c) => {
  const id = parseId(c.req.param('id'));
  const db = c.env.DB;
  const current = await getTx(db, id);
  const others = (await loadPositionTransactions(db, current.account_id, current.instrument_id)).filter(
    (t) => t.id !== id,
  );
  assertPositionValid(others);
  await db.prepare('DELETE FROM transactions WHERE id = ?1').bind(id).run();
  return c.body(null, 204);
});

export default app;
