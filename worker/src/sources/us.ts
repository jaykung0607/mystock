import { newYorkDateOf } from '../lib/dates';
import { type Fetch, getJson, SourceError } from './common';

/**
 * 美股。
 *
 * Yahoo Finance chart（非官方，⚠ 待驗證：開發環境回 429，無法實測）：
 *   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=&period2=&interval=1d
 *   chart.result[0].timestamp[] 與 indicators.quote[0].close[] 對應；meta.regularMarketPrice 為最新價。
 *   close 已做分割調整、未做除息調整。
 *
 * Finnhub（需 API key，免費方案只有即時 quote，沒有歷史 K 線；⚠ 待驗證）：
 *   https://finnhub.io/api/v1/quote?symbol=AAPL  header X-Finnhub-Token
 *   { c: 現價, pc: 前收, t: unix 秒 }
 */

export interface DailyClose {
  date: string;
  close: string;
}

export interface Quote {
  price: string;
  /** 報價時間 unix 秒 */
  time: number;
}

/** 數字 → 十進位字串，最多 6 位小數。 */
function num(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return String(Number(v.toFixed(6)));
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: { regularMarketPrice?: number; regularMarketTime?: number };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

function yahooResult(body: unknown) {
  const b = body as YahooChart;
  const r = b.chart?.result?.[0];
  if (!r) throw new SourceError('yahoo', b.chart?.error?.description ?? '沒有資料');
  return r;
}

export function parseYahooDaily(body: unknown): DailyClose[] {
  const r = yahooResult(body);
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const out: DailyClose[] = [];
  ts.forEach((t, i) => {
    const close = num(closes[i]);
    if (close) out.push({ date: newYorkDateOf(t), close });
  });
  return out;
}

export function parseYahooQuote(body: unknown): Quote | null {
  const m = yahooResult(body).meta;
  const price = num(m?.regularMarketPrice);
  return price && m?.regularMarketTime ? { price, time: m.regularMarketTime } : null;
}

function yahooUrl(symbol: string, query: string) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
}

export async function fetchYahooDaily(fetcher: Fetch, symbol: string, from: string, to: string): Promise<DailyClose[]> {
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 2 * 86400;
  return parseYahooDaily(await getJson(fetcher, 'yahoo', yahooUrl(symbol, `period1=${p1}&period2=${p2}&interval=1d`)));
}

export async function fetchYahooQuote(fetcher: Fetch, symbol: string): Promise<Quote | null> {
  return parseYahooQuote(await getJson(fetcher, 'yahoo', yahooUrl(symbol, 'range=1d&interval=1d')));
}

export function parseFinnhubQuote(body: unknown): Quote | null {
  const b = body as { c?: number; t?: number; error?: string };
  if (b.error) throw new SourceError('finnhub', b.error);
  const price = num(b.c);
  return price && b.t ? { price, time: b.t } : null;
}

export async function fetchFinnhubQuote(fetcher: Fetch, apiKey: string, symbol: string): Promise<Quote | null> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
  return parseFinnhubQuote(await getJson(fetcher, 'finnhub', url, { headers: { 'X-Finnhub-Token': apiKey } }));
}
