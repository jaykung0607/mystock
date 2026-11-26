import {
  calcPosition,
  summarizePositions,
  valuePosition,
  type CalcTransaction,
  type InstrumentType,
  type PortfolioPosition,
  type PortfolioSummary,
} from '@mystock/shared';
import { weekdaysAfter } from '../lib/dates';
import type { Quote } from '../sources/us';
import { TX_CALC_COLUMNS } from './transactions';

/** 收盤價超過幾個交易日沒更新就標示過期 */
export const STALE_TRADING_DAYS = 3;

interface TxRow extends CalcTransaction {
  account_id: number;
  instrument_id: number;
  user_id: number;
}

interface PositionMeta {
  account_id: number;
  account_name: string;
  user_id: number;
  instrument_id: number;
  type: InstrumentType;
  symbol: string;
  name: string;
  currency: string;
  share_class: string;
  data_source: string;
  source_key: string;
}

export interface UserPortfolio {
  user_id: number;
  positions: PortfolioPosition[];
  summary: PortfolioSummary;
}

/**
 * 讀取多位使用者的持倉並評價（一次 batch、5 個查詢，不受使用者數影響）。
 * 報價用 prices_daily 最新一筆、匯率用 fx_daily 最新一筆；盤中報價在第 3 步加入。
 */
export interface ValuationOptions {
  /** 台灣今天（判斷報價是否過期） */
  today: string;
  /** 取盤中報價（只會被呼叫一次，傳入所有持有的標的） */
  intraday?: (targets: { id: number; data_source: string; source_key: string; symbol: string }[]) => Promise<Map<number, Quote>>;
}

export async function loadPortfolios(
  db: D1Database,
  userIds: number[],
  opts: ValuationOptions,
): Promise<Map<number, UserPortfolio>> {
  const ids = JSON.stringify(userIds);
  const userFilter = 'a.user_id IN (SELECT value FROM json_each(?1))';
  const [txRes, metaRes, priceRes, fxRes] = await db.batch([
    db
      .prepare(
        `SELECT ${TX_CALC_COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')}, t.account_id, t.instrument_id, a.user_id
         FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE ${userFilter}`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT DISTINCT a.id AS account_id, a.name AS account_name, a.user_id,
                i.id AS instrument_id, i.type, i.symbol, i.name, i.currency, i.share_class,
                i.data_source, i.source_key
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN instruments i ON i.id = t.instrument_id
         WHERE ${userFilter}
         ORDER BY a.user_id, a.id, i.symbol`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT p.instrument_id, p.date, p.close FROM prices_daily p
         JOIN (SELECT instrument_id, MAX(date) AS d FROM prices_daily
               WHERE instrument_id IN (SELECT DISTINCT t.instrument_id FROM transactions t
                                       JOIN accounts a ON a.id = t.account_id WHERE ${userFilter})
               GROUP BY instrument_id) m
           ON m.instrument_id = p.instrument_id AND m.d = p.date`,
      )
      .bind(ids),
    db.prepare(
      `SELECT f.currency, f.date, f.rate FROM fx_daily f
       JOIN (SELECT currency, MAX(date) AS d FROM fx_daily GROUP BY currency) m
         ON m.currency = f.currency AND m.d = f.date`,
    ),
  ]);

  const txs = (txRes!.results as TxRow[]) ?? [];
  const metas = (metaRes!.results as PositionMeta[]) ?? [];
  const prices = new Map(
    ((priceRes!.results as { instrument_id: number; date: string; close: string }[]) ?? []).map((p) => [
      p.instrument_id,
      { close: p.close, date: p.date },
    ]),
  );
  const fxs = new Map(
    ((fxRes!.results as { currency: string; date: string; rate: string }[]) ?? []).map((f) => [
      f.currency,
      { rate: f.rate, date: f.date },
    ]),
  );

  const live = opts.intraday
    ? await opts.intraday(
        [...new Map(metas.map((m) => [m.instrument_id, m])).values()].map((m) => ({
          id: m.instrument_id,
          data_source: m.data_source,
          source_key: m.source_key,
          symbol: m.symbol,
        })),
      )
    : new Map<number, Quote>();

  const txByPosition = new Map<string, CalcTransaction[]>();
  for (const t of txs) {
    const key = `${t.account_id}:${t.instrument_id}`;
    const list = txByPosition.get(key) ?? [];
    list.push(t);
    txByPosition.set(key, list);
  }

  const result = new Map<number, UserPortfolio>();
  const itemsByUser = new Map<number, Parameters<typeof summarizePositions>[0][number][]>();
  for (const uid of userIds) {
    result.set(uid, { user_id: uid, positions: [], summary: summarizePositions([]) });
    itemsByUser.set(uid, []);
  }

  for (const m of metas) {
    const closePrice = prices.get(m.instrument_id) ?? null;
    const quote = live.get(m.instrument_id);
    const price: PortfolioPosition['price'] = quote
      ? { close: quote.price, date: opts.today, intraday: true, time: new Date(quote.time * 1000).toISOString() }
      : closePrice;
    const fx = m.currency === 'TWD' ? { rate: '1', date: price?.date ?? '' } : (fxs.get(m.currency) ?? null);
    const position: PortfolioPosition = {
      account_id: m.account_id,
      account_name: m.account_name,
      instrument: {
        id: m.instrument_id,
        type: m.type,
        symbol: m.symbol,
        name: m.name,
        currency: m.currency,
        share_class: m.share_class,
      },
      state: null,
      valuation: null,
      price,
      price_stale: !quote && (!closePrice || weekdaysAfter(closePrice.date, opts.today) > STALE_TRADING_DAYS),
      fx: m.currency === 'TWD' ? null : fx,
    };
    try {
      const state = calcPosition(txByPosition.get(`${m.account_id}:${m.instrument_id}`) ?? []);
      position.state = state;
      position.valuation = valuePosition(state, {
        price: fx ? (price?.close ?? null) : null,
        fx_rate: fx?.rate ?? '1',
      });
      itemsByUser.get(m.user_id)!.push({ state, valuation: position.valuation });
    } catch (err) {
      position.error = err instanceof Error ? err.message : String(err);
    }
    result.get(m.user_id)!.positions.push(position);
  }

  for (const [uid, items] of itemsByUser) result.get(uid)!.summary = summarizePositions(items);
  return result;
}
