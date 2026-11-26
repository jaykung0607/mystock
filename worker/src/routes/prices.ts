import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound, parseId, parseParam, validate } from '../lib/http';
import { currency, date, decimal } from '../lib/schemas';
import { requireAdmin } from '../middleware/auth';
import { invalidateSnapshots } from '../services/snapshots';

/**
 * 價格與匯率：查詢歷史（走勢圖）、admin 手動輸入（基金淨值、抓不到時補資料）。
 * 手動輸入的資料 source='manual'，排程不會覆寫。
 */
const app = new Hono<AppEnv>();

const range = z.object({ from: date.optional(), to: date.optional() });

app.get('/prices/:instrumentId', validate('query', range), async (c) => {
  const { from, to } = c.req.valid('query');
  const { results } = await c.env.DB.prepare(
    `SELECT date, close, source FROM prices_daily
     WHERE instrument_id = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date`,
  )
    .bind(parseId(c.req.param('instrumentId')), from ?? '0000-00-00', to ?? '9999-99-99')
    .all();
  return c.json({ prices: results });
});

app.put('/prices/:instrumentId/:date', requireAdmin, validate('json', z.object({ close: decimal })), async (c) => {
  const instrumentId = parseId(c.req.param('instrumentId'));
  const d = parseParam(date, c.req.param('date'), '日期');
  const exists = await c.env.DB.prepare('SELECT id FROM instruments WHERE id = ?1').bind(instrumentId).first();
  if (!exists) notFound('找不到此標的');
  const { close } = c.req.valid('json');
  await c.env.DB.prepare(
    `INSERT INTO prices_daily (instrument_id, date, close, source) VALUES (?1, ?2, ?3, 'manual')
     ON CONFLICT (instrument_id, date) DO UPDATE SET close = excluded.close, source = 'manual',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(instrumentId, d, close)
    .run();
  await invalidateSnapshots(c.env.DB, d);
  return c.json({ price: { instrument_id: instrumentId, date: d, close, source: 'manual' } });
});

app.delete('/prices/:instrumentId/:date', requireAdmin, async (c) => {
  const d = parseParam(date, c.req.param('date'), '日期');
  const res = await c.env.DB.prepare('DELETE FROM prices_daily WHERE instrument_id = ?1 AND date = ?2')
    .bind(parseId(c.req.param('instrumentId')), d)
    .run();
  if (res.meta.changes === 0) notFound('找不到此價格');
  await invalidateSnapshots(c.env.DB, d);
  return c.body(null, 204);
});

app.get('/fx/:currency', validate('query', range), async (c) => {
  const { from, to } = c.req.valid('query');
  const cur = parseParam(currency, c.req.param('currency'), '幣別');
  const { results } = await c.env.DB.prepare(
    'SELECT date, rate, source FROM fx_daily WHERE currency = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date',
  )
    .bind(cur, from ?? '0000-00-00', to ?? '9999-99-99')
    .all();
  return c.json({ rates: results });
});

app.put('/fx/:currency/:date', requireAdmin, validate('json', z.object({ rate: decimal })), async (c) => {
  const cur = parseParam(currency, c.req.param('currency'), '幣別');
  const d = parseParam(date, c.req.param('date'), '日期');
  const { rate } = c.req.valid('json');
  await c.env.DB.prepare(
    `INSERT INTO fx_daily (currency, date, rate, source) VALUES (?1, ?2, ?3, 'manual')
     ON CONFLICT (currency, date) DO UPDATE SET rate = excluded.rate, source = 'manual',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(cur, d, rate)
    .run();
  await invalidateSnapshots(c.env.DB, d);
  return c.json({ rate: { currency: cur, date: d, rate, source: 'manual' } });
});

export default app;
