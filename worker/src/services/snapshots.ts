import {
  calcPosition,
  D,
  OUT_DP,
  out,
  PositionError,
  sortTransactions,
  type CalcTransaction,
  valuePosition,
} from '@mystock/shared';
import { addDays, maxDate, weekdaysDesc } from '../lib/dates';
import { TX_CALC_COLUMNS } from './transactions';

/**
 * 每人每日資產快照（資產走勢圖用，SPEC §5、§7）。
 *
 * - 日期：從該使用者第一筆交易日起的每個平日，最多回補 MAX_DAYS 天
 * - 當日部位：該日（含）以前的交易；報價與匯率用該日（含）以前最新一筆
 * - 缺報價的部位以成本計入市值，避免走勢圖突然掉下去
 * - 已存在的日期不重算；今天每次都重算。過去資料改變時由呼叫端刪掉受影響的快照
 */

export const SNAPSHOT_MAX_DAYS = 800;

interface TxRow extends CalcTransaction {
  user_id: number;
  account_id: number;
  instrument_id: number;
  currency: string;
}

export interface SnapshotRow {
  user_id: number;
  date: string;
  market_value_twd: string;
  cost_twd: string;
}

type Series = { date: string; value: string }[];

/** 已排序（舊到新）的序列中，找 date（含）以前最新一筆。 */
function asOf(series: Series | undefined, date: string): string | null {
  if (!series || series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? series[found]!.value : null;
}

export function computeSnapshots(input: {
  transactions: TxRow[];
  prices: Map<number, Series>;
  fx: Map<string, Series>;
  dates: Map<number, string[]>;
}): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const byUser = new Map<number, TxRow[]>();
  for (const t of input.transactions) {
    const list = byUser.get(t.user_id) ?? [];
    list.push(t);
    byUser.set(t.user_id, list);
  }

  for (const [userId, dates] of input.dates) {
    const userTxs = sortTransactions(byUser.get(userId) ?? []);
    const positions = new Map<string, TxRow[]>();
    for (const t of userTxs) {
      const key = `${t.account_id}:${t.instrument_id}`;
      const list = positions.get(key) ?? [];
      list.push(t);
      positions.set(key, list);
    }

    for (const date of dates) {
      let mv = D(0);
      let cost = D(0);
      for (const txs of positions.values()) {
        const upTo = txs.filter((t) => t.trade_date <= date);
        if (upTo.length === 0) continue;
        const first = upTo[0]!;
        let state;
        try {
          state = calcPosition(upTo);
        } catch (err) {
          if (err instanceof PositionError) continue;
          throw err;
        }
        cost = cost.plus(state.cost_twd);
        const fx = first.currency === 'TWD' ? '1' : asOf(input.fx.get(first.currency), date);
        const price = asOf(input.prices.get(first.instrument_id), date);
        const v = fx && price ? valuePosition(state, { price, fx_rate: fx }) : null;
        mv = mv.plus(v?.market_value_twd ?? state.cost_twd);
      }
      rows.push({ user_id: userId, date, market_value_twd: out(mv, OUT_DP.money), cost_twd: out(cost, OUT_DP.money) });
    }
  }
  return rows;
}

/** 補齊缺少的快照並重算今天。回傳寫入筆數。 */
export async function refreshSnapshots(db: D1Database, today: string): Promise<number> {
  const [usersRes, txRes, existingRes] = await db.batch([
    db.prepare(
      `SELECT a.user_id, MIN(t.trade_date) AS first_date FROM transactions t
       JOIN accounts a ON a.id = t.account_id GROUP BY a.user_id`,
    ),
    db.prepare(
      `SELECT ${TX_CALC_COLUMNS.split(', ').map((c) => `t.${c}`).join(', ')},
              a.user_id, t.account_id, t.instrument_id, i.currency
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN instruments i ON i.id = t.instrument_id`,
    ),
    db.prepare('SELECT user_id, date FROM portfolio_snapshots WHERE date < ?1').bind(today),
  ]);
  const users = usersRes!.results as { user_id: number; first_date: string }[];
  if (users.length === 0) return 0;

  const existing = new Set((existingRes!.results as { user_id: number; date: string }[]).map((r) => `${r.user_id}:${r.date}`));
  const floor = addDays(today, -SNAPSHOT_MAX_DAYS);
  const dates = new Map<number, string[]>();
  let earliest = today;
  for (const u of users) {
    const start = maxDate(u.first_date, floor);
    const missing = weekdaysDesc(start, today).filter((d) => d === today || !existing.has(`${u.user_id}:${d}`));
    // 週末也寫今天，讓走勢圖最後一點是最新狀態
    if (!missing.includes(today)) missing.unshift(today);
    if (missing.length) dates.set(u.user_id, missing);
    if (missing.length && missing[missing.length - 1]! < earliest) earliest = missing[missing.length - 1]!;
  }
  if (dates.size === 0) return 0;

  const [priceRes, fxRes] = await db.batch([
    // 需要 earliest 以前最近的一筆當起點，所以從更早 30 天開始讀
    db.prepare('SELECT instrument_id, date, close FROM prices_daily WHERE date >= ?1 ORDER BY instrument_id, date').bind(addDays(earliest, -30)),
    db.prepare('SELECT currency, date, rate FROM fx_daily WHERE date >= ?1 ORDER BY currency, date').bind(addDays(earliest, -30)),
  ]);
  const prices = new Map<number, Series>();
  for (const p of priceRes!.results as { instrument_id: number; date: string; close: string }[]) {
    const s = prices.get(p.instrument_id) ?? [];
    s.push({ date: p.date, value: p.close });
    prices.set(p.instrument_id, s);
  }
  const fx = new Map<string, Series>();
  for (const f of fxRes!.results as { currency: string; date: string; rate: string }[]) {
    const s = fx.get(f.currency) ?? [];
    s.push({ date: f.date, value: f.rate });
    fx.set(f.currency, s);
  }

  const rows = computeSnapshots({ transactions: txRes!.results as TxRow[], prices, fx, dates });
  await writeJsonRows(
    db,
    `INSERT OR REPLACE INTO portfolio_snapshots (user_id, date, market_value_twd, cost_twd)
     SELECT json_extract(value, '$.user_id'), json_extract(value, '$.date'),
            json_extract(value, '$.market_value_twd'), json_extract(value, '$.cost_twd')
     FROM json_each(?1)`,
    rows,
  );
  return rows.length;
}

/** 過去資料改變後，刪掉受影響的快照（之後排程會補回）。userId 省略 = 所有人。 */
export async function invalidateSnapshots(db: D1Database, fromDate: string, userId?: number): Promise<void> {
  if (userId === undefined) {
    await db.prepare('DELETE FROM portfolio_snapshots WHERE date >= ?1').bind(fromDate).run();
  } else {
    await db.prepare('DELETE FROM portfolio_snapshots WHERE user_id = ?1 AND date >= ?2').bind(userId, fromDate).run();
  }
}

/** 用 json_each 一次寫入多列（D1 每個語句最多 100 個參數），每批 500 列。 */
export async function writeJsonRows(db: D1Database, sql: string, rows: object[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    stmts.push(db.prepare(sql).bind(JSON.stringify(rows.slice(i, i + 500))));
  }
  if (stmts.length) await db.batch(stmts);
}
