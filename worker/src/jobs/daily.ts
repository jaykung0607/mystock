import type { Env } from '../env';
import { addDays, maxDate, newYorkDateOf, newYorkNow, taipeiNow, weekdaysDesc } from '../lib/dates';
import { fetchBotSpotSell } from '../sources/bot';
import { type Fetch, SourceError } from '../sources/common';
import { fetchTwDay } from '../sources/tw';
import { type DailyClose, fetchFinnhubQuote, fetchYahooDaily } from '../sources/us';
import { invalidateSnapshots, refreshSnapshots, writeJsonRows } from '../services/snapshots';

/**
 * 每日排程（SPEC §7）。每次執行都做完整檢查，只抓缺的資料，可重跑（idempotent）：
 *   1. 台股（tw）：找出還沒處理過的平日，新到舊，每次最多 maxTwDates 天
 *   2. 美股（yahoo / finnhub）：每檔最新價早於最近一個已收盤交易日才抓
 *   3. 匯率（台銀）：台灣平日 16:00 後、當日尚無匯率才抓
 *   4. 寫入的價格若早於今天 → 刪掉之後的快照；最後補齊快照
 *
 * Workers 免費方案每次呼叫最多 50 個對外請求：台股每天 2 個、美股每檔 1 個、匯率 1 個。
 * 手動輸入（source='manual'）的價格與匯率不會被覆寫。
 */

export const TW_SOURCES = ['tw', 'twse', 'tpex'];
/** 回補多久以前的價格 */
export const PRICE_LOOKBACK_DAYS = 800;
/** 只有關注、沒有交易的標的回補幾天 */
const WATCH_LOOKBACK_DAYS = 10;

export interface JobDeps {
  fetch: Fetch;
  now: Date;
  /** 台股兩個日期之間的間隔（毫秒）。TWSE 約每 5 秒超過 3 次就會封鎖一陣子。預設 2500。 */
  twDelayMs?: number;
}

export interface JobOptions {
  maxTwDates?: number;
  /** 預算用完的對外請求上限（保留給其他步驟） */
  maxRequests?: number;
}

export interface JobReport {
  tw: { fetched: string[]; empty: string[]; prices: number; remaining: number };
  us: { prices: number; symbols: string[] };
  fx: { rates: Record<string, string>; skipped?: string };
  snapshots: number;
  errors: string[];
}

interface InstrumentRow {
  id: number;
  type: string;
  symbol: string;
  currency: string;
  data_source: string;
  source_key: string;
  start: string | null;
  watched: number;
  latest: string | null;
}

interface PricePoint {
  instrument_id: number;
  date: string;
  close: string;
}

async function upsertPrices(db: D1Database, points: PricePoint[]): Promise<void> {
  await writeJsonRows(
    db,
    `INSERT INTO prices_daily (instrument_id, date, close, source)
     SELECT json_extract(value, '$.instrument_id'), json_extract(value, '$.date'), json_extract(value, '$.close'), 'auto'
     FROM json_each(?1) WHERE true
     ON CONFLICT (instrument_id, date) DO UPDATE SET close = excluded.close,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE prices_daily.source = 'auto'`,
    points,
  );
}

/** 美股最近一個「已收盤」的交易日（美東 16:15 後算當天收盤）。 */
export function lastClosedUsSession(now: Date): string {
  const ny = newYorkNow(now);
  let d = ny.minutes >= 16 * 60 + 15 ? ny.date : addDays(ny.date, -1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1);
  return d;
}

export async function runDailyJob(env: Env, deps: JobDeps, opts: JobOptions = {}): Promise<JobReport> {
  const db = env.DB;
  const maxTwDates = opts.maxTwDates ?? 10;
  let budget = opts.maxRequests ?? 45;
  const tw = taipeiNow(deps.now);
  const today = tw.date;
  const floor = addDays(today, -PRICE_LOOKBACK_DAYS);
  const report: JobReport = {
    tw: { fetched: [], empty: [], prices: 0, remaining: 0 },
    us: { prices: 0, symbols: [] },
    fx: { rates: {} },
    snapshots: 0,
    errors: [],
  };
  let earliestWrite: string | null = null;
  const noteWrite = (date: string) => {
    if (date < today && (earliestWrite === null || date < earliestWrite)) earliestWrite = date;
  };

  const { results: instruments } = await db
    .prepare(
      `SELECT i.id, i.type, i.symbol, i.currency, i.data_source, i.source_key,
              (SELECT MIN(trade_date) FROM transactions t WHERE t.instrument_id = i.id) AS start,
              EXISTS (SELECT 1 FROM watchlist w WHERE w.instrument_id = i.id) AS watched,
              (SELECT MAX(date) FROM prices_daily p WHERE p.instrument_id = i.id) AS latest
       FROM instruments i`,
    )
    .all<InstrumentRow>();
  const active = instruments
    .map((i) => ({
      ...i,
      start: i.start ? maxDate(i.start, floor) : i.watched ? addDays(today, -WATCH_LOOKBACK_DAYS) : null,
    }))
    .filter((i): i is InstrumentRow & { start: string } => i.start !== null);

  // ---- 1. 台股 ----
  const twInstruments = active.filter((i) => TW_SOURCES.includes(i.data_source));
  if (twInstruments.length) {
    const start = twInstruments.reduce((m, i) => (i.start < m ? i.start : m), today);
    const { results: logged } = await db
      .prepare("SELECT date FROM fetch_log WHERE source = 'tw' AND date >= ?1")
      .bind(start)
      .all<{ date: string }>();
    const done = new Set(logged.map((r) => r.date));
    // 台灣 14:00 前今天還沒收盤，不抓今天
    const lastDay = tw.minutes >= 14 * 60 ? today : addDays(today, -1);
    const todo = weekdaysDesc(start, lastDay).filter((d) => !done.has(d));
    const batch = todo.slice(0, Math.min(maxTwDates, Math.floor(budget / 2)));
    report.tw.remaining = todo.length - batch.length;

    for (const [n, date] of batch.entries()) {
      if (n > 0 && (deps.twDelayMs ?? 2500) > 0) await new Promise((r) => setTimeout(r, deps.twDelayMs ?? 2500));
      budget -= 2;
      try {
        const day = await fetchTwDay(deps.fetch, date);
        if (day.status === 'empty') {
          // 今天沒資料可能只是還沒公布，不記錄，下次再試
          if (date < today) {
            await db.prepare("INSERT OR REPLACE INTO fetch_log (source, date, status) VALUES ('tw', ?1, 'empty')").bind(date).run();
            report.tw.empty.push(date);
          }
          continue;
        }
        const points: PricePoint[] = [];
        for (const i of twInstruments) {
          const close = day.closes.get(i.source_key || i.symbol);
          if (close && date >= i.start) points.push({ instrument_id: i.id, date, close });
        }
        await upsertPrices(db, points);
        await db
          .prepare("INSERT OR REPLACE INTO fetch_log (source, date, status, row_count) VALUES ('tw', ?1, 'ok', ?2)")
          .bind(date, points.length)
          .run();
        if (points.length) noteWrite(date);
        report.tw.fetched.push(date);
        report.tw.prices += points.length;
      } catch (err) {
        report.errors.push(`台股 ${date}：${(err as Error).message}`);
        if (err instanceof SourceError && err.blocked) {
          report.errors.push('台股：來源限流，這次先停止，下次排程再補');
          report.tw.remaining = todo.length - report.tw.fetched.length - report.tw.empty.length;
          break;
        }
      }
    }
  }

  // ---- 2. 美股 ----
  const usSession = lastClosedUsSession(deps.now);
  for (const i of active.filter((x) => x.data_source === 'yahoo' || x.data_source === 'finnhub')) {
    if (i.latest && i.latest >= usSession) continue;
    if (budget <= 1) {
      report.errors.push(`美股 ${i.symbol}：本次請求額度用完，下次再抓`);
      continue;
    }
    budget--;
    const symbol = i.source_key || i.symbol;
    try {
      let points: DailyClose[];
      if (i.data_source === 'yahoo') {
        const from = i.latest ? maxDate(addDays(i.latest, 1), i.start) : i.start;
        points = (await fetchYahooDaily(deps.fetch, symbol, from, usSession)).filter(
          (p) => p.date >= from && p.date <= usSession,
        );
      } else {
        if (!env.FINNHUB_API_KEY) throw new Error('未設定 FINNHUB_API_KEY');
        const q = await fetchFinnhubQuote(deps.fetch, env.FINNHUB_API_KEY, symbol);
        const date = q ? newYorkDateOf(q.time) : null;
        // 免費方案只有即時報價：只收已收盤交易日的價格
        points = q && date && date <= usSession ? [{ date, close: q.price }] : [];
      }
      await upsertPrices(db, points.map((p) => ({ instrument_id: i.id, ...p })));
      for (const p of points) noteWrite(p.date);
      report.us.prices += points.length;
      report.us.symbols.push(symbol);
    } catch (err) {
      report.errors.push(`美股 ${symbol}：${(err as Error).message}`);
    }
  }

  // ---- 3. 匯率 ----
  const currencies = [...new Set(active.map((i) => i.currency).filter((c) => c !== 'TWD'))];
  if (currencies.length === 0) {
    report.fx.skipped = '沒有外幣標的';
  } else if (tw.weekday === 0 || tw.weekday === 6 || tw.minutes < 16 * 60) {
    report.fx.skipped = '只在台灣平日 16:00 後抓';
  } else {
    const { results: have } = await db
      .prepare('SELECT currency FROM fx_daily WHERE date = ?1')
      .bind(today)
      .all<{ currency: string }>();
    const need = currencies.filter((c) => !have.some((h) => h.currency === c));
    if (need.length === 0) {
      report.fx.skipped = '今天已有匯率';
    } else {
      try {
        const rates = await fetchBotSpotSell(deps.fetch);
        const rows = need.flatMap((c) => (rates.has(c) ? [{ currency: c, date: today, rate: rates.get(c)! }] : []));
        for (const c of need) if (!rates.has(c)) report.errors.push(`匯率：台銀沒有 ${c}`);
        await writeJsonRows(
          db,
          `INSERT INTO fx_daily (currency, date, rate, source)
           SELECT json_extract(value, '$.currency'), json_extract(value, '$.date'), json_extract(value, '$.rate'), 'auto'
           FROM json_each(?1) WHERE true
           ON CONFLICT (currency, date) DO UPDATE SET rate = excluded.rate,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE fx_daily.source = 'auto'`,
          rows,
        );
        for (const r of rows) report.fx.rates[r.currency] = r.rate;
      } catch (err) {
        report.errors.push(`匯率：${(err as Error).message}（請在設定頁手動輸入）`);
      }
    }
  }

  // ---- 4. 快照 ----
  if (earliestWrite) await invalidateSnapshots(db, earliestWrite);
  try {
    report.snapshots = await refreshSnapshots(db, today);
  } catch (err) {
    report.errors.push(`快照：${(err as Error).message}`);
  }

  return report;
}
