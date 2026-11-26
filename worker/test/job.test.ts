import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDailyJob } from '../src/jobs/daily';
import { BOT_CSV, fakeFetch, yahooChart } from './fake-fetch';
import { ADMIN, client, resetDb } from './helpers';

/** 2026-11-24（二）台灣 16:30 */
const TUE_1630_TW = new Date('2026-11-24T08:30:00Z');

let ids: { tw: number; us: number; etf: number; tsmc: number; aapl: number; fund: number };

async function seed() {
  const admin = await client(ADMIN);
  const tw = (await admin.post('/accounts', { user_id: 2, name: '證券戶', currency: 'TWD' })).body.account.id;
  const us = (await admin.post('/accounts', { user_id: 2, name: '複委託', currency: 'USD' })).body.account.id;
  const etf = (await admin.post('/instruments', { type: 'tw_stock', symbol: '006208', name: '富邦台50', currency: 'TWD' })).body.instrument.id;
  const tsmc = (await admin.post('/instruments', { type: 'tw_stock', symbol: '2330', name: '台積電', currency: 'TWD' })).body.instrument.id;
  const aapl = (await admin.post('/instruments', { type: 'us_stock', symbol: 'AAPL', name: 'Apple', currency: 'USD' })).body.instrument.id;
  const fund = (await admin.post('/instruments', { type: 'offshore_fund', symbol: 'BGF-WT', name: '世界科技', currency: 'USD', share_class: 'A2' })).body.instrument.id;
  ids = { tw, us, etf, tsmc, aapl, fund };
  // 006208 從 11/20（五）開始持有；2330 沒有交易也沒關注 → 不抓
  await admin.post('/transactions', { account_id: tw, instrument_id: etf, type: 'buy', trade_date: '2026-11-20', quantity: '1000', price: '200', fee: '0' });
  await admin.post('/transactions', { account_id: us, instrument_id: aapl, type: 'buy', trade_date: '2026-11-23', quantity: '10', price: '200', fx_rate: '32' });
  return admin;
}

const market = {
  tw: {
    '2026-11-20': { '006208': '200', '2330': '2000' },
    '2026-11-24': { '006208': '215.10', '2330': '2230' },
    // 11-23 休市（測試用）
  },
  bot: BOT_CSV,
  yahoo: {
    // 2026-11-23、11-24 美東收盤
    AAPL: yahooChart([
      [Date.parse('2026-11-23T14:30:00Z') / 1000, 210],
      [Date.parse('2026-11-24T14:30:00Z') / 1000, 220],
    ]),
  },
};

async function prices(instrumentId: number) {
  const { results } = await env.DB.prepare('SELECT date, close, source FROM prices_daily WHERE instrument_id = ?1 ORDER BY date')
    .bind(instrumentId)
    .all();
  return results;
}

beforeEach(resetDb);

describe('每日排程', () => {
  it('台股：補抓缺漏日、只寫有持有／關注的標的、記錄休市', async () => {
    await seed();
    const fetch = fakeFetch(market);
    const report = await runDailyJob(env, { fetch, now: TUE_1630_TW, twDelayMs: 0 });

    expect(report.errors).toEqual([]);
    expect(report.tw.fetched).toEqual(['2026-11-24', '2026-11-20']);
    expect(report.tw.empty).toEqual(['2026-11-23']);
    expect(await prices(ids.etf)).toEqual([
      { date: '2026-11-20', close: '200', source: 'auto' },
      { date: '2026-11-24', close: '215.1', source: 'auto' },
    ]);
    expect(await prices(ids.tsmc)).toEqual([]);
  });

  it('休市日只問 TPEx，不打 TWSE', async () => {
    await seed();
    const fetch = fakeFetch(market);
    await runDailyJob(env, { fetch, now: TUE_1630_TW, twDelayMs: 0 });
    expect(fetch.calls.filter((u) => u.includes('twse.com.tw') && u.includes('20261123'))).toHaveLength(0);
    expect(fetch.calls.filter((u) => u.includes('tpex') && u.includes('2026%2F11%2F23'))).toHaveLength(1);
  });

  it('重跑不會重抓已處理的日期（idempotent）', async () => {
    await seed();
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    const fetch = fakeFetch(market);
    const report = await runDailyJob(env, { fetch, now: TUE_1630_TW, twDelayMs: 0 });
    expect(fetch.calls.filter((u) => u.includes('twse'))).toHaveLength(0);
    expect(fetch.calls.filter((u) => u.includes('yahoo'))).toHaveLength(0);
    expect(fetch.calls.filter((u) => u.includes('bot'))).toHaveLength(0);
    expect(report.tw.fetched).toEqual([]);
  });

  it('台灣 14:00 前不抓今天；今天沒資料不記錄，之後會再試', async () => {
    await seed();
    const morning = new Date('2026-11-24T03:00:00Z'); // 台灣 11:00
    const r1 = await runDailyJob(env, { fetch: fakeFetch(market), now: morning, twDelayMs: 0 });
    expect(r1.tw.fetched).not.toContain('2026-11-24');

    const noTodayYet = { ...market, tw: { '2026-11-20': market.tw['2026-11-20'] } };
    const r2 = await runDailyJob(env, { fetch: fakeFetch(noTodayYet), now: TUE_1630_TW, twDelayMs: 0 });
    expect(r2.tw.empty).not.toContain('2026-11-24');

    const r3 = await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    expect(r3.tw.fetched).toEqual(['2026-11-24']);
  });

  it('新增標的後會回補它的歷史價格', async () => {
    const admin = await seed();
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    await admin.post('/transactions', { account_id: ids.tw, instrument_id: ids.tsmc, type: 'opening', trade_date: '2026-11-20', quantity: '1', amount: '2000' });
    // 2330 原本就存在，所以要模擬「改資料來源」觸發重抓
    await admin.patch(`/instruments/${ids.tsmc}`, { source_key: '2330' });
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    expect((await prices(ids.tsmc)).map((p: any) => p.close)).toEqual(['2000', '2230']);
  });

  it('不覆寫手動輸入的價格', async () => {
    const admin = await seed();
    await admin.put(`/prices/${ids.etf}/2026-11-24`, { close: '999' });
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    expect((await prices(ids.etf)).find((p: any) => p.date === '2026-11-24')).toMatchObject({ close: '999', source: 'manual' });
  });

  it('單次請求數有上限，剩下的下次再抓', async () => {
    await seed();
    const report = await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 }, { maxTwDates: 1 });
    expect(report.tw.fetched).toEqual(['2026-11-24']);
    expect(report.tw.remaining).toBe(2);
  });

  it('美股（Yahoo）：只收已收盤交易日', async () => {
    await seed();
    // 台灣 11/25 06:30 = 美東 11/24 17:30，11/24 已收盤
    const report = await runDailyJob(env, { fetch: fakeFetch(market), now: new Date('2026-11-24T22:30:00Z'), twDelayMs: 0 });
    expect(report.us.prices).toBe(2);
    expect((await prices(ids.aapl)).map((p: any) => [p.date, p.close])).toEqual([
      ['2026-11-23', '210'],
      ['2026-11-24', '220'],
    ]);

    await resetDb();
    await seed();
    // 美東 11/24 盤中：只收 11/23
    await runDailyJob(env, { fetch: fakeFetch(market), now: new Date('2026-11-24T16:00:00Z'), twDelayMs: 0 });
    expect((await prices(ids.aapl)).map((p: any) => p.date)).toEqual(['2026-11-23']);
  });

  it('TWSE 回 HTML 安全頁（限流）→ 這次停止抓台股，未完成的日期下次再抓', async () => {
    await seed();
    const blocked = fakeFetch(market);
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('twse')
        ? new Response('<html>因為安全性考量，您所執行的頁面無法呈現。</html>', { headers: { 'Content-Type': 'text/html' } })
        : blocked(input, init)) as typeof globalThis.fetch;
    const report = await runDailyJob(env, { fetch, now: TUE_1630_TW, twDelayMs: 0 });
    expect(report.tw.fetched).toEqual([]);
    expect(report.tw.empty).toEqual([]); // 11/23 雖然 TPEx 休市，但在 11/24 被擋之後就停了
    expect(report.errors.some((e) => e.includes('限流'))).toBe(true);
    expect(report.errors.filter((e) => e.startsWith('台股 '))).toHaveLength(1);
    const logged = await env.DB.prepare('SELECT COUNT(*) AS n FROM fetch_log').first();
    expect(logged).toEqual({ n: 0 });
  });

  it('美股失敗只記錯誤，不影響其他步驟', async () => {
    await seed();
    const report = await runDailyJob(env, { fetch: fakeFetch({ ...market, yahoo: {} }), now: TUE_1630_TW, twDelayMs: 0 });
    expect(report.errors.some((e) => e.includes('AAPL') && e.includes('429'))).toBe(true);
    expect(report.tw.fetched.length).toBeGreaterThan(0);
  });

  it('匯率：台灣平日 16:00 後抓台銀即期賣出', async () => {
    await seed();
    const report = await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    expect(report.fx.rates).toEqual({ USD: '32.365' });
    const row = await env.DB.prepare("SELECT rate, source FROM fx_daily WHERE currency = 'USD' AND date = '2026-11-24'").first();
    expect(row).toEqual({ rate: '32.365', source: 'auto' });

    const early = await runDailyJob(env, { fetch: fakeFetch(market), now: new Date('2026-11-25T03:00:00Z'), twDelayMs: 0 });
    expect(early.fx.skipped).toContain('16:00');
  });

  it('台銀回驗證頁 → 回報錯誤並提示手動輸入', async () => {
    await seed();
    const report = await runDailyJob(env, { fetch: fakeFetch({ ...market, bot: undefined }), now: TUE_1630_TW, twDelayMs: 0 });
    expect(report.errors.some((e) => e.includes('匯率') && e.includes('HTML'))).toBe(true);
  });

  it('寫入快照：從第一筆交易日開始，缺報價以成本計', async () => {
    await seed();
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    const { results } = await env.DB.prepare('SELECT date, market_value_twd, cost_twd FROM portfolio_snapshots WHERE user_id = 2 ORDER BY date').all();
    // 11/20：006208 200×1000
    // 11/23：+AAPL；有 11/23 收盤但沒有 11/23 以前的匯率 → 以成本 64000 計
    // 11/24：006208 215.1×1000 + AAPL 210×10×32.365（11/23 收盤、11/24 匯率）
    expect(results).toEqual([
      { date: '2026-11-20', market_value_twd: '200000', cost_twd: '200000' },
      { date: '2026-11-23', market_value_twd: '264000', cost_twd: '264000' },
      { date: '2026-11-24', market_value_twd: '283066.5', cost_twd: '264000' },
    ]);
  });

  it('修改過去交易 → 之後的快照被刪除，下次排程補回', async () => {
    const admin = await seed();
    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    await admin.post('/transactions', { account_id: ids.tw, instrument_id: ids.etf, type: 'buy', trade_date: '2026-11-23', quantity: '100', price: '210', fee: '0' });
    const after = await env.DB.prepare('SELECT date FROM portfolio_snapshots WHERE user_id = 2 ORDER BY date').all();
    expect(after.results.map((r: any) => r.date)).toEqual(['2026-11-20']);

    await runDailyJob(env, { fetch: fakeFetch(market), now: TUE_1630_TW, twDelayMs: 0 });
    const row = await env.DB.prepare("SELECT market_value_twd FROM portfolio_snapshots WHERE user_id = 2 AND date = '2026-11-24'").first();
    expect(row).toEqual({ market_value_twd: '304576.5' }); // 1100 × 215.1 + 67966.5
  });
});
