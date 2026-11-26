import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeFetch, yahooChart } from './fake-fetch';
import { ADMIN, client, KID1, KID2, resetDb } from './helpers';

/** 2026-11-26（四）台灣 10:00（台股盤中）、美東 11/25 21:00（美股收盤後） */
const TW_INTRADAY = new Date('2026-11-26T02:00:00Z');

async function setup(fetch = fakeFetch({})) {
  const now = () => TW_INTRADAY;
  const admin = await client(ADMIN, { fetch, now });
  const kid1 = await client(KID1, { fetch, now });
  const tw = (await admin.post('/accounts', { user_id: 2, name: '證券戶', currency: 'TWD' })).body.account.id;
  const tsmc = (await admin.post('/instruments', { type: 'tw_stock', symbol: '2330', name: '台積電', currency: 'TWD' })).body.instrument.id;
  const fund = (await admin.post('/instruments', { type: 'tw_fund', symbol: 'F001', name: '某基金', currency: 'TWD' })).body.instrument.id;
  await admin.post('/transactions', { account_id: tw, instrument_id: tsmc, type: 'buy', trade_date: '2026-11-20', quantity: '10', price: '2000', fee: '0' });
  await admin.post('/transactions', { account_id: tw, instrument_id: fund, type: 'buy', trade_date: '2026-11-20', quantity: '100', price: '10' });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO prices_daily (instrument_id, date, close) VALUES (?1, '2026-11-25', '2230')").bind(tsmc),
    env.DB.prepare("INSERT INTO prices_daily (instrument_id, date, close) VALUES (?1, '2026-11-20', '10.5')").bind(fund),
  ]);
  return { admin, kid1, tsmc, fund };
}

const pos = (body: any, symbol: string) => body.positions.find((p: any) => p.instrument.symbol === symbol);

beforeEach(async () => {
  await resetDb();
  for (const key of ['tw/2330', 'yahoo/AAPL']) await caches.default.delete(`https://quotes.internal/${key}`);
});

describe('標的預設資料來源', () => {
  it('依類型決定', async () => {
    const { admin } = await setup();
    const list = (await admin.get('/instruments')).body.instruments;
    expect(Object.fromEntries(list.map((i: any) => [i.symbol, i.data_source]))).toEqual({ '2330': 'tw', F001: 'manual' });
    expect((await admin.post('/instruments', { type: 'us_stock', symbol: 'AAPL', name: 'Apple', currency: 'USD' })).body.instrument.data_source).toBe('yahoo');
    expect((await admin.post('/instruments', { type: 'us_stock', symbol: 'X', name: 'x', currency: 'USD', data_source: 'nope' })).status).toBe(400);
  });
});

describe('報價過期與盤中報價', () => {
  it('收盤價超過 3 個交易日未更新 → price_stale', async () => {
    const { kid1 } = await setup();
    const body = (await kid1.get('/portfolio')).body;
    expect(pos(body, '2330').price_stale).toBe(false);
    expect(pos(body, 'F001').price_stale).toBe(true); // 11/20 → 11/26 隔 4 個交易日
  });

  it('live=1：交易時段用盤中延遲報價，並快取 5 分鐘', async () => {
    const fetch = fakeFetch({ mis: { msgArray: [{ c: '2330', z: '2250.00', tlong: String(TW_INTRADAY.getTime()) }] } });
    const { kid1 } = await setup(fetch);
    const body = (await kid1.get('/portfolio?live=1')).body;
    expect(pos(body, '2330').price).toMatchObject({ close: '2250', date: '2026-11-26', intraday: true });
    expect(pos(body, '2330').valuation.market_value_twd).toBe('22500');
    expect(pos(body, 'F001').price).toMatchObject({ close: '10.5', date: '2026-11-20' });

    await kid1.get('/portfolio?live=1');
    expect(fetch.calls.filter((u) => u.includes('mis.twse'))).toHaveLength(1);
  });

  it('盤中報價失敗 → 退回最近收盤價', async () => {
    const { kid1 } = await setup(fakeFetch({}));
    const body = (await kid1.get('/portfolio?live=1')).body;
    expect(pos(body, '2330').price).toEqual({ close: '2230', date: '2026-11-25' });
  });

  it('非交易時段不抓', async () => {
    const fetch = fakeFetch({ mis: { msgArray: [] } });
    const { admin } = await setup(fetch);
    const night = await client(ADMIN, { fetch, now: () => new Date('2026-11-26T12:00:00Z') });
    await night.get('/portfolio?user_id=2&live=1');
    expect(fetch.calls.filter((u) => u.includes('mis.twse'))).toHaveLength(0);
    void admin;
  });

  it('美股盤中用 Yahoo', async () => {
    const usOpen = new Date('2026-11-25T15:00:00Z'); // 美東 10:00
    const fetch = fakeFetch({ yahoo: { AAPL: yahooChart([[usOpen.getTime() / 1000, 250]]) } });
    const admin = await client(ADMIN, { fetch, now: () => usOpen });
    const acc = (await admin.post('/accounts', { user_id: 2, name: '複委託', currency: 'USD' })).body.account.id;
    const aapl = (await admin.post('/instruments', { type: 'us_stock', symbol: 'AAPL', name: 'Apple', currency: 'USD' })).body.instrument.id;
    await admin.post('/transactions', { account_id: acc, instrument_id: aapl, type: 'buy', trade_date: '2026-11-20', quantity: '2', price: '200', fx_rate: '32' });
    await env.DB.prepare("INSERT INTO fx_daily (currency, date, rate) VALUES ('USD', '2026-11-24', '32.5')").run();
    const body = (await admin.get('/portfolio?user_id=2&live=1')).body;
    expect(pos(body, 'AAPL').price).toMatchObject({ close: '250', intraday: true });
    expect(pos(body, 'AAPL').valuation.market_value_twd).toBe('16250');
  });
});

describe('手動價格與匯率', () => {
  it('admin 可手動填基金淨值，之後不再過期', async () => {
    const { admin, kid1, fund } = await setup();
    expect((await kid1.put(`/prices/${fund}/2026-11-25`, { close: '11' })).status).toBe(403);
    const res = await admin.put(`/prices/${fund}/2026-11-25`, { close: '11' });
    expect(res.body.price).toEqual({ instrument_id: fund, date: '2026-11-25', close: '11', source: 'manual' });
    const body = (await kid1.get('/portfolio')).body;
    expect(pos(body, 'F001').price_stale).toBe(false);
    expect(pos(body, 'F001').valuation.market_value_twd).toBe('1100');

    expect((await kid1.get(`/prices/${fund}?from=2026-11-21`)).body.prices).toEqual([{ date: '2026-11-25', close: '11', source: 'manual' }]);
    expect((await admin.del(`/prices/${fund}/2026-11-25`)).status).toBe(204);
    expect((await admin.put(`/prices/${fund}/2026-13-01`, { close: '11' })).status).toBe(400);
    expect((await admin.put('/prices/999/2026-11-25', { close: '11' })).status).toBe(404);
  });

  it('admin 可手動填匯率，交易自動帶入', async () => {
    const { admin } = await setup();
    expect((await admin.put('/fx/USD/2026-11-25', { rate: '32.1' })).status).toBe(200);
    expect((await admin.put('/fx/usd/2026-11-25', { rate: '32.1' })).status).toBe(400);
    expect((await admin.get('/fx/USD')).body.rates).toEqual([{ date: '2026-11-25', rate: '32.1', source: 'manual' }]);
  });
});

describe('資產走勢與排程', () => {
  it('admin 觸發排程，小孩看自己的走勢、admin 看全家合計', async () => {
    const { admin, kid1 } = await setup(fakeFetch({}));
    const kid2 = await client(KID2);
    expect((await kid1.post('/jobs/daily', {})).status).toBe(403);
    const run = await admin.post('/jobs/daily', {});
    expect(run.status).toBe(200);
    expect(run.body.report.snapshots).toBeGreaterThan(0);

    const mine = (await kid1.get('/portfolio/history')).body;
    expect(mine.user_id).toBe(2);
    expect(mine.points.at(-1)).toEqual({ date: '2026-11-26', market_value_twd: '23350', cost_twd: '21000' });
    expect((await kid2.get('/portfolio/history?user_id=2')).status).toBe(403);

    const fam = (await admin.get('/portfolio/history?from=2026-11-26')).body;
    expect(fam.user_id).toBeNull();
    expect(fam.points).toEqual([{ date: '2026-11-26', market_value_twd: '23350', cost_twd: '21000' }]);
  });
});
