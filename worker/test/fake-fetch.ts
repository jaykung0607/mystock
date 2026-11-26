import tpexDay from './fixtures/tpex_otc_20261124.json';
import twseDay from './fixtures/twse_mi_index_20261124.json';

/**
 * 依 URL 回應的假 fetch。twse/tpex 以實際回應為範本換日期與價格；
 * 沒有在 days 裡的日期當作休市。
 */
export interface FakeMarket {
  /** date → { 代號: 收盤價 } */
  tw?: Record<string, Record<string, string>>;
  bot?: string;
  yahoo?: Record<string, unknown>;
  mis?: unknown;
}

export function fakeFetch(market: FakeMarket) {
  const calls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);

    if (url.hostname === 'www.twse.com.tw') {
      const d = url.searchParams.get('date')!;
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      const day = market.tw?.[iso];
      if (!day) return json({ stat: '很抱歉，沒有符合條件的資料!', type: 'ALLBUT0999' });
      const body = structuredClone(twseDay) as any;
      body.date = d;
      const table = body.tables.find((t: any) => t.title?.includes('每日收盤行情'));
      const template = table.data[0];
      table.data = Object.entries(day).map(([code, close]) => {
        const row = [...template];
        row[0] = code;
        row[8] = close;
        return row;
      });
      return json(body);
    }

    if (url.hostname === 'www.tpex.org.tw') {
      const d = url.searchParams.get('date')!.replaceAll('/', '');
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      const body = structuredClone(tpexDay) as any;
      body.date = d;
      // 測試中的台股都當作上市，上櫃永遠回空表
      body.tables[0].data = [];
      body.tables[0].totalCount = market.tw?.[iso] ? 1 : 0;
      return json(body);
    }

    if (url.hostname === 'rate.bot.com.tw') {
      if (!market.bot) return new Response('<!DOCTYPE html><html>Challenge</html>', { headers: { 'Content-Type': 'text/html' } });
      return new Response(market.bot, { headers: { 'Content-Type': 'text/csv' } });
    }

    if (url.hostname === 'query1.finance.yahoo.com') {
      const symbol = decodeURIComponent(url.pathname.split('/').pop()!);
      const body = market.yahoo?.[symbol];
      return body ? json(body) : new Response('Too Many Requests', { status: 429 });
    }

    if (url.hostname === 'mis.twse.com.tw') {
      return market.mis ? json(market.mis) : new Response('blocked', { status: 502 });
    }

    return new Response('unexpected', { status: 500 });
  };

  return Object.assign(fn as typeof fetch, { calls });
}

export const BOT_CSV = [
  '幣別,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天,匯率,現金,即期,遠期10天,遠期30天,遠期60天,遠期90天,遠期120天,遠期150天,遠期180天',
  'USD,本行買入,31.89,32.215,32.18,32.13,32.06,31.99,31.92,31.85,31.78,本行賣出,32.56,32.365,32.33,32.28,32.21,32.14,32.07,32.00,31.93',
].join('\n');

/** Yahoo chart 回應：points 為 [unix 秒, close]。 */
export function yahooChart(points: [number, number][], latest?: number) {
  return {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: latest ?? points.at(-1)?.[1], regularMarketTime: points.at(-1)?.[0] },
          timestamp: points.map((p) => p[0]),
          indicators: { quote: [{ close: points.map((p) => p[1]) }] },
        },
      ],
      error: null,
    },
  };
}
