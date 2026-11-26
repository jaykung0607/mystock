import { Hono } from 'hono';
import type { Instrument } from '@mystock/shared';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { conflict, isUniqueError, notFound, parseId, validate } from '../lib/http';
import { instrumentCreate, instrumentUpdate } from '../lib/schemas';
import { requireAdmin } from '../middleware/auth';

const app = new Hono<AppEnv>();

const DEFAULT_SOURCE: Record<string, string> = {
  tw_stock: 'tw',
  us_stock: 'yahoo',
  tw_fund: 'manual',
  offshore_fund: 'manual',
};

/** 台股是依日期批次抓；新增／變更台股標的後清掉抓取紀錄，讓新標的的歷史價格補抓進來。 */
async function resetTwFetchLog(db: D1Database) {
  await db.prepare("DELETE FROM fetch_log WHERE source = 'tw'").run();
}

// 所有登入者可查（小孩加關注清單要用）
app.get('/', validate('query', z.object({ q: z.string().trim().max(50).optional() })), async (c) => {
  const { q } = c.req.valid('query');
  const stmt = q
    ? c.env.DB.prepare(
        "SELECT * FROM instruments WHERE symbol LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' ORDER BY symbol LIMIT 50",
      ).bind(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    : c.env.DB.prepare('SELECT * FROM instruments ORDER BY type, symbol');
  const { results } = await stmt.all<Instrument>();
  return c.json({ instruments: results });
});

app.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM instruments WHERE id = ?1')
    .bind(parseId(c.req.param('id')))
    .first<Instrument>();
  if (!row) notFound('找不到此標的');
  return c.json({ instrument: row });
});

app.post('/', requireAdmin, validate('json', instrumentCreate), async (c) => {
  const b = c.req.valid('json');
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO instruments (type, symbol, name, currency, share_class, data_source, source_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`,
    )
      .bind(
        b.type,
        b.symbol,
        b.name,
        b.currency,
        b.share_class,
        b.data_source ?? DEFAULT_SOURCE[b.type],
        b.source_key ?? b.symbol,
      )
      .first<Instrument>();
    if (row?.data_source === 'tw') await resetTwFetchLog(c.env.DB);
    return c.json({ instrument: row }, 201);
  } catch (err) {
    if (isUniqueError(err)) conflict('已有相同類型、代號與級別的標的');
    throw err;
  }
});

/** 幣別、類型、代號建立後不可改（會影響既有交易的意義）。 */
app.patch('/:id', requireAdmin, validate('json', instrumentUpdate), async (c) => {
  const b = c.req.valid('json');
  try {
    const row = await c.env.DB.prepare(
      `UPDATE instruments SET name = COALESCE(?2, name), share_class = COALESCE(?3, share_class),
         data_source = COALESCE(?4, data_source), source_key = COALESCE(?5, source_key)
       WHERE id = ?1 RETURNING *`,
    )
      .bind(parseId(c.req.param('id')), b.name ?? null, b.share_class ?? null, b.data_source ?? null, b.source_key ?? null)
      .first<Instrument>();
    if (!row) notFound('找不到此標的');
    if (row.data_source === 'tw' && (b.data_source || b.source_key)) await resetTwFetchLog(c.env.DB);
    return c.json({ instrument: row });
  } catch (err) {
    if (isUniqueError(err)) conflict('已有相同類型、代號與級別的標的');
    throw err;
  }
});

export default app;
