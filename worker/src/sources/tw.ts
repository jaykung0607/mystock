import { compact } from '../lib/dates';
import { type Fetch, getJson, parsePrice, SourceError } from './common';

/**
 * 台股每日收盤（已實測 2026-11）：
 * - 上市 TWSE：https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=YYYYMMDD&type=ALLBUT0999
 *   tables[] 中 title 含「每日收盤行情」的表，fields[0]=證券代號、fields 中「收盤價」
 *   休市：{"stat":"很抱歉，沒有符合條件的資料!"}；未來日期：{"stat":"查詢日期大於今日，請重新查詢!"}
 * - 上櫃 TPEx：https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=YYYY/MM/DD&type=EW&response=json
 *   tables[0]，fields[0]=代號、fields 中「收盤」；休市或未來日期 totalCount=0
 * 無成交的證券收盤價為 "--" / "----"，略過。
 * 一個日期 2 個請求，回傳該日全部上市櫃證券。
 */

export type DayResult = { status: 'ok'; closes: Map<string, string> } | { status: 'empty' };

interface Table {
  title?: string;
  date?: string;
  fields?: string[];
  data?: unknown[][];
  totalCount?: number;
}

function extract(table: Table, codeField: string, closeField: string): Map<string, string> {
  const fields = (table.fields ?? []).map((f) => f.trim());
  const ci = fields.indexOf(codeField);
  const pi = fields.indexOf(closeField);
  if (ci < 0 || pi < 0) throw new Error(`找不到欄位 ${codeField}/${closeField}：${fields.join(',')}`);
  const out = new Map<string, string>();
  for (const row of table.data ?? []) {
    const code = String(row[ci] ?? '').trim();
    const close = parsePrice(row[pi]);
    if (code && close) out.set(code, close);
  }
  return out;
}

export function parseTwse(body: unknown, date: string): DayResult {
  const b = body as { stat?: string; date?: string; tables?: Table[] };
  if (b.stat !== 'OK') {
    if (b.stat && /沒有符合條件|大於今日/.test(b.stat)) return { status: 'empty' };
    throw new SourceError('twse', `stat=${b.stat}`);
  }
  if (b.date !== compact(date)) throw new SourceError('twse', `回應日期 ${b.date} 與要求的 ${date} 不符`);
  const table = (b.tables ?? []).find((t) => t.title?.includes('每日收盤行情'));
  if (!table) throw new SourceError('twse', '找不到每日收盤行情表');
  try {
    return { status: 'ok', closes: extract(table, '證券代號', '收盤價') };
  } catch (err) {
    throw new SourceError('twse', (err as Error).message);
  }
}

export function parseTpex(body: unknown, date: string): DayResult {
  const b = body as { stat?: string; date?: string; tables?: Table[] };
  if (b.stat !== 'ok') throw new SourceError('tpex', `stat=${b.stat}`);
  if (b.date !== compact(date)) throw new SourceError('tpex', `回應日期 ${b.date} 與要求的 ${date} 不符`);
  const table = b.tables?.[0];
  if (!table || !table.totalCount) return { status: 'empty' };
  try {
    return { status: 'ok', closes: extract(table, '代號', '收盤') };
  } catch (err) {
    throw new SourceError('tpex', (err as Error).message);
  }
}

export async function fetchTwse(fetcher: Fetch, date: string): Promise<DayResult> {
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${compact(date)}&type=ALLBUT0999`;
  return parseTwse(await getJson(fetcher, 'twse', url), date);
}

export async function fetchTpex(fetcher: Fetch, date: string): Promise<DayResult> {
  const d = encodeURIComponent(date.replaceAll('-', '/'));
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${d}&type=EW&response=json`;
  return parseTpex(await getJson(fetcher, 'tpex', url), date);
}

/**
 * 上市 + 上櫃合併。先問 TPEx：上市櫃休市日相同，TPEx 沒資料就當休市、不再打 TWSE。
 * （實測 TWSE 對某些休市日回 HTML 錯誤頁而非「沒有符合條件」，先問 TPEx 可避免卡住；休市日也少一個請求。）
 */
export async function fetchTwDay(fetcher: Fetch, date: string): Promise<DayResult> {
  const tpex = await fetchTpex(fetcher, date);
  if (tpex.status === 'empty') return { status: 'empty' };
  const twse = await fetchTwse(fetcher, date);
  const closes = new Map<string, string>();
  if (tpex.status === 'ok') for (const [k, v] of tpex.closes) closes.set(k, v);
  if (twse.status === 'ok') for (const [k, v] of twse.closes) closes.set(k, v);
  return { status: 'ok', closes };
}
