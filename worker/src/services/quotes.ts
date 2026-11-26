import type { Env } from '../env';
import { newYorkNow, taipeiNow } from '../lib/dates';
import type { Fetch } from '../sources/common';
import { fetchMis } from '../sources/mis';
import { fetchFinnhubQuote, fetchYahooQuote, type Quote } from '../sources/us';
import { TW_SOURCES } from '../jobs/daily';

/**
 * 盤中延遲報價（SPEC §7）：只在交易時段抓，Cache API 快取 5 分鐘，不寫 D1。
 * 任何錯誤都吞掉，呼叫端退回最近收盤價。
 */

export const QUOTE_TTL_SECONDS = 300;

export interface QuoteTarget {
  id: number;
  data_source: string;
  source_key: string;
  symbol: string;
}

export function isTwTradingHours(now: Date): boolean {
  const t = taipeiNow(now);
  return t.weekday >= 1 && t.weekday <= 5 && t.minutes >= 9 * 60 && t.minutes <= 13 * 60 + 35;
}

export function isUsTradingHours(now: Date): boolean {
  const t = newYorkNow(now);
  return t.weekday >= 1 && t.weekday <= 5 && t.minutes >= 9 * 60 + 30 && t.minutes <= 16 * 60;
}

function cacheKey(source: string, key: string) {
  return new Request(`https://quotes.internal/${source}/${encodeURIComponent(key)}`);
}

async function cached(source: string, key: string): Promise<Quote | null | undefined> {
  const res = await caches.default.match(cacheKey(source, key));
  return res ? ((await res.json()) as Quote | null) : undefined;
}

async function store(source: string, key: string, quote: Quote | null): Promise<void> {
  await caches.default.put(
    cacheKey(source, key),
    new Response(JSON.stringify(quote), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${QUOTE_TTL_SECONDS}` },
    }),
  );
}

export async function getIntradayQuotes(
  env: Env,
  fetcher: Fetch,
  now: Date,
  targets: QuoteTarget[],
): Promise<Map<number, Quote>> {
  const out = new Map<number, Quote>();
  const keyOf = (t: QuoteTarget) => t.source_key || t.symbol;

  // 台股：一次請求全部
  if (isTwTradingHours(now)) {
    const tw = targets.filter((t) => TW_SOURCES.includes(t.data_source));
    const missing: QuoteTarget[] = [];
    for (const t of tw) {
      const q = await cached('tw', keyOf(t));
      if (q === undefined) missing.push(t);
      else if (q) out.set(t.id, q);
    }
    if (missing.length) {
      try {
        const quotes = await fetchMis(fetcher, [...new Set(missing.map(keyOf))]);
        for (const t of missing) {
          const q = quotes.get(keyOf(t)) ?? null;
          await store('tw', keyOf(t), q);
          if (q) out.set(t.id, q);
        }
      } catch (err) {
        console.warn('盤中報價（台股）失敗', err);
      }
    }
  }

  // 美股：每檔一個請求
  if (isUsTradingHours(now)) {
    for (const t of targets.filter((x) => x.data_source === 'yahoo' || x.data_source === 'finnhub')) {
      try {
        let q = await cached(t.data_source, keyOf(t));
        if (q === undefined) {
          if (t.data_source === 'yahoo') q = await fetchYahooQuote(fetcher, keyOf(t));
          else q = env.FINNHUB_API_KEY ? await fetchFinnhubQuote(fetcher, env.FINNHUB_API_KEY, keyOf(t)) : null;
          await store(t.data_source, keyOf(t), q);
        }
        if (q) out.set(t.id, q);
      } catch (err) {
        console.warn(`盤中報價（${keyOf(t)}）失敗`, err);
      }
    }
  }

  return out;
}
