import { type Fetch, getJson, parsePrice } from './common';
import type { Quote } from './us';

/**
 * 台股盤中延遲報價：TWSE 基本市況報導網站（非官方 JSON）。
 *   https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw|otc_6488.tw
 *   { msgArray: [{ c: 代號, z: 最近成交價（無成交為 "-"）, tlong: 毫秒時間戳, ... }] }
 *
 * ⚠ 待驗證：開發環境被對方防火牆擋下（502），格式依公開資料撰寫，解析一律容錯，
 * 失敗時呼叫端退回最近收盤價。不知道是上市或上櫃時，兩種都送（不存在的會被忽略）。
 */
export function parseMis(body: unknown): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const arr = (body as { msgArray?: unknown[] })?.msgArray;
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    const m = item as { c?: string; z?: string; tlong?: string | number };
    const price = parsePrice(m.z);
    const time = Number(m.tlong);
    if (m.c && price && Number.isFinite(time)) out.set(m.c, { price, time: Math.floor(time / 1000) });
  }
  return out;
}

export async function fetchMis(fetcher: Fetch, codes: string[]): Promise<Map<string, Quote>> {
  if (codes.length === 0) return new Map();
  const exCh = codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;
  return parseMis(await getJson(fetcher, 'mis', url));
}
