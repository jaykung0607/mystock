import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, client, KID1, KID2, resetDb } from './helpers';

type Client = Awaited<ReturnType<typeof client>>;
let admin: Client;
let kid1: Client;
let kid2: Client;

/** 建立常用資料：kid1 有台股帳戶與複委託帳戶，標的 2330、006208、AAPL */
async function seed() {
  const tw = (await admin.post('/accounts', { user_id: 2, name: '老大證券戶', broker: '元大', currency: 'TWD' })).body.account;
  const us = (await admin.post('/accounts', { user_id: 2, name: '老大複委託', currency: 'USD' })).body.account;
  const tsmc = (await admin.post('/instruments', { type: 'tw_stock', symbol: '2330', name: '台積電', currency: 'TWD' })).body.instrument;
  const etf = (await admin.post('/instruments', { type: 'tw_stock', symbol: '006208', name: '富邦台50', currency: 'TWD' })).body.instrument;
  const aapl = (await admin.post('/instruments', { type: 'us_stock', symbol: 'AAPL', name: 'Apple', currency: 'USD', data_source: 'finnhub' })).body.instrument;
  return { tw, us, tsmc, etf, aapl };
}

beforeEach(async () => {
  await resetDb();
  admin = await client(ADMIN);
  kid1 = await client(KID1);
  kid2 = await client(KID2);
});

describe('權限', () => {
  it('小孩不能寫入任何東西', async () => {
    const { tw, tsmc } = await seed();
    expect((await kid1.post('/accounts', { user_id: 2, name: 'x', currency: 'TWD' })).status).toBe(403);
    expect((await kid1.post('/instruments', { type: 'tw_stock', symbol: '2317', name: 'x', currency: 'TWD' })).status).toBe(403);
    expect(
      (await kid1.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '1', price: '1' })).status,
    ).toBe(403);
    expect((await kid1.get('/users')).status).toBe(403);
    expect((await kid1.get('/settings')).status).toBe(403);
    expect((await kid1.get('/portfolio/family')).status).toBe(403);
  });

  it('小孩只能讀自己的帳戶、交易、帳本', async () => {
    const { tw, tsmc } = await seed();
    const tx = (await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '10', price: '500', fee: '0', tax: '0' })).body.transaction;

    expect((await kid1.get('/accounts')).body.accounts).toHaveLength(2);
    expect((await kid2.get('/accounts')).body.accounts).toHaveLength(0);
    expect((await kid2.get('/accounts?user_id=2')).status).toBe(403);

    expect((await kid1.get('/transactions')).body.transactions).toHaveLength(1);
    expect((await kid2.get('/transactions')).body.transactions).toHaveLength(0);
    // 小孩帶別人的 account_id 也只會拿到自己的（空）
    expect((await kid2.get(`/transactions?account_id=${tw.id}`)).body.transactions).toHaveLength(0);
    expect((await kid2.get(`/transactions/${tx.id}`)).status).toBe(403);
    expect((await kid1.get(`/transactions/${tx.id}`)).status).toBe(200);

    expect((await kid1.get('/portfolio')).body.user_id).toBe(2);
    expect((await kid2.get('/portfolio?user_id=2')).status).toBe(403);
    expect((await admin.get('/portfolio?user_id=2')).status).toBe(200);
  });

  it('小孩可以查標的清單（關注清單要用）', async () => {
    await seed();
    const res = await kid1.get('/instruments?q=台積');
    expect(res.status).toBe(200);
    expect(res.body.instruments).toHaveLength(1);
  });
});

describe('帳戶與標的', () => {
  it('建立、修改、刪除帳戶；有交易時不能刪', async () => {
    const { tw, tsmc } = await seed();
    const upd = await admin.patch(`/accounts/${tw.id}`, { broker: null });
    expect(upd.body.account.broker).toBeNull();
    expect(upd.body.account.name).toBe('老大證券戶');

    await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '1', price: '1' });
    expect((await admin.del(`/accounts/${tw.id}`)).status).toBe(409);

    const empty = (await admin.post('/accounts', { user_id: 3, name: '老二', currency: 'TWD' })).body.account;
    expect((await admin.del(`/accounts/${empty.id}`)).status).toBe(204);
  });

  it('標的重複 → 409；境外基金不同級別可並存', async () => {
    await seed();
    expect((await admin.post('/instruments', { type: 'tw_stock', symbol: '2330', name: '台積電', currency: 'TWD' })).status).toBe(409);
    const a2 = await admin.post('/instruments', { type: 'offshore_fund', symbol: 'BGF-WT', name: '貝萊德世界科技基金', currency: 'USD', share_class: 'A2' });
    const a10 = await admin.post('/instruments', { type: 'offshore_fund', symbol: 'BGF-WT', name: '貝萊德世界科技基金', currency: 'USD', share_class: 'A10' });
    expect(a2.status).toBe(201);
    expect(a10.status).toBe(201);
    expect(a2.body.instrument.source_key).toBe('BGF-WT');
  });

  it('格式錯誤 → 400', async () => {
    const res = await admin.post('/accounts', { user_id: 2, name: '', currency: 'usd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });
});

describe('交易 CRUD', () => {
  it('台股買進未填手續費 → 依 settings 自動計算', async () => {
    const { tw, tsmc } = await seed();
    await admin.put('/settings', { tw_fee_discount: '0.6' });
    const res = await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '1000' });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ fee: '85', tax: '0', fx_rate: '1', created_by: 1, status: 'confirmed' });
  });

  it('台股賣出 ETF 自動計算證交稅 0.1%；手動填則照填', async () => {
    const { tw, etf } = await seed();
    await admin.post('/transactions', { account_id: tw.id, instrument_id: etf.id, type: 'buy', trade_date: '2026-01-05', quantity: '1000', price: '100', fee: '0' });
    const sell = await admin.post('/transactions', { account_id: tw.id, instrument_id: etf.id, type: 'sell', trade_date: '2026-02-05', quantity: '1000', price: '100' });
    expect(sell.body.transaction).toMatchObject({ fee: '142', tax: '100' });
  });

  it('外幣未填匯率 → 帶入交易日以前最近的台銀匯率；查無則 400', async () => {
    const { us, aapl } = await seed();
    const base = { account_id: us.id, instrument_id: aapl.id, type: 'buy', quantity: '10', price: '200' };
    expect((await admin.post('/transactions', { ...base, trade_date: '2026-01-05' })).status).toBe(400);

    await env.DB.prepare("INSERT INTO fx_daily (currency, date, rate) VALUES ('USD', '2026-01-02', '31.5')").run();
    const res = await admin.post('/transactions', { ...base, trade_date: '2026-01-05' });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ fx_rate: '31.5', fee: '0' });

    const manual = await admin.post('/transactions', { ...base, trade_date: '2026-01-06', fx_rate: '31.2', fee: '3' });
    expect(manual.body.transaction).toMatchObject({ fx_rate: '31.2', fee: '3' });
  });

  it('依類型檢查必填與清除不適用欄位', async () => {
    const { tw, tsmc } = await seed();
    const base = { account_id: tw.id, instrument_id: tsmc.id, trade_date: '2026-01-05' };
    expect((await admin.post('/transactions', { ...base, type: 'buy', quantity: '1' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, type: 'opening', quantity: '1' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, type: 'dividend_cash' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, type: 'split' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, type: 'buy', quantity: '0', price: '1' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, type: 'buy', quantity: '-1', price: '1' })).status).toBe(400);
    expect((await admin.post('/transactions', { ...base, trade_date: '2026-02-30', type: 'buy', quantity: '1', price: '1' })).status).toBe(400);

    await admin.post('/transactions', { ...base, type: 'buy', quantity: '1', price: '1' });
    const split = await admin.post('/transactions', { ...base, type: 'split', split_ratio: '2', quantity: '9', price: '9' });
    expect(split.status).toBe(201);
    expect(split.body.transaction).toMatchObject({ quantity: null, price: null, split_ratio: '2', fee: '0' });
  });

  it('賣超過持有 → 400，不寫入', async () => {
    const { tw, tsmc } = await seed();
    const base = { account_id: tw.id, instrument_id: tsmc.id };
    await admin.post('/transactions', { ...base, type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '1' });
    const res = await admin.post('/transactions', { ...base, type: 'sell', trade_date: '2026-01-06', quantity: '101', price: '1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('超過');
    expect((await admin.get('/transactions')).body.transactions).toHaveLength(1);
  });

  it('修改或刪除造成歷史上賣超過 → 400', async () => {
    const { tw, tsmc } = await seed();
    const base = { account_id: tw.id, instrument_id: tsmc.id };
    const buy = (await admin.post('/transactions', { ...base, type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '1' })).body.transaction;
    await admin.post('/transactions', { ...base, type: 'sell', trade_date: '2026-01-06', quantity: '80', price: '1' });

    expect((await admin.patch(`/transactions/${buy.id}`, { quantity: '50' })).status).toBe(400);
    expect((await admin.patch(`/transactions/${buy.id}`, { trade_date: '2026-01-07' })).status).toBe(400);
    expect((await admin.del(`/transactions/${buy.id}`)).status).toBe(400);

    const ok = await admin.patch(`/transactions/${buy.id}`, { quantity: '90', note: '更正' });
    expect(ok.status).toBe(200);
    expect(ok.body.transaction).toMatchObject({ quantity: '90', note: '更正', fee: '20' });
  });

  it('PATCH 不能改帳戶或標的；可確認 pending', async () => {
    const { tw, tsmc } = await seed();
    const tx = (await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '1', price: '1', status: 'pending' })).body.transaction;
    expect(tx.status).toBe('pending');
    expect((await admin.patch(`/transactions/${tx.id}`, { account_id: 999 })).status).toBe(400);
    const ok = await admin.patch(`/transactions/${tx.id}`, { status: 'confirmed', price: '1.1' });
    expect(ok.body.transaction).toMatchObject({ status: 'confirmed', price: '1.1' });
  });

  it('PATCH fee: "auto" 重新計算', async () => {
    const { tw, tsmc } = await seed();
    const tx = (await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '1000', fee: '1' })).body.transaction;
    const res = await admin.patch(`/transactions/${tx.id}`, { fee: 'auto' });
    expect(res.body.transaction.fee).toBe('142');
  });

  it('列表篩選', async () => {
    const { tw, tsmc, etf } = await seed();
    await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'buy', trade_date: '2026-01-05', quantity: '1', price: '1' });
    await admin.post('/transactions', { account_id: tw.id, instrument_id: etf.id, type: 'buy', trade_date: '2026-02-05', quantity: '1', price: '1' });
    expect((await admin.get(`/transactions?instrument_id=${etf.id}`)).body.transactions).toHaveLength(1);
    expect((await admin.get('/transactions?from=2026-02-01')).body.transactions).toHaveLength(1);
    expect((await admin.get('/transactions?user_id=3')).body.transactions).toHaveLength(0);
    const all = (await admin.get('/transactions')).body.transactions;
    expect(all[0].trade_date).toBe('2026-02-05'); // 新到舊
  });
});

describe('帳本與全家合計', () => {
  it('持倉、評價與彙總（含外幣、缺報價）', async () => {
    const { tw, us, tsmc, etf, aapl } = await seed();
    await admin.post('/transactions', { account_id: tw.id, instrument_id: tsmc.id, type: 'opening', trade_date: '2025-12-31', quantity: '100', amount: '50000' });
    await admin.post('/transactions', { account_id: us.id, instrument_id: aapl.id, type: 'buy', trade_date: '2026-01-05', quantity: '10', price: '200', fx_rate: '30' });
    await admin.post('/transactions', { account_id: tw.id, instrument_id: etf.id, type: 'buy', trade_date: '2026-01-05', quantity: '1000', price: '100', fee: '0' });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO prices_daily (instrument_id, date, close) VALUES (?1, '2026-01-30', '600'), (?1, '2026-01-29', '1')`).bind(tsmc.id),
      env.DB.prepare(`INSERT INTO prices_daily (instrument_id, date, close) VALUES (?1, '2026-01-30', '250')`).bind(aapl.id),
      env.DB.prepare(`INSERT INTO fx_daily (currency, date, rate) VALUES ('USD', '2026-01-30', '32'), ('USD', '2026-01-01', '1')`),
    ]);

    const res = await kid1.get('/portfolio');
    expect(res.status).toBe(200);
    const byS = Object.fromEntries(res.body.positions.map((p: any) => [p.instrument.symbol, p]));

    expect(byS['2330'].valuation.market_value_twd).toBe('60000');
    expect(byS['2330'].price).toEqual({ close: '600', date: '2026-01-30' });

    expect(byS['AAPL'].fx).toEqual({ rate: '32', date: '2026-01-30' });
    expect(byS['AAPL'].valuation).toMatchObject({
      market_value_orig: '2500',
      market_value_twd: '80000',
      unrealized: { invest_orig: '500', fx_twd: '4000', total_twd: '20000' },
    });

    expect(byS['006208'].valuation.market_value_twd).toBeNull();

    expect(res.body.summary).toMatchObject({
      market_value_twd: '140000',
      cost_twd: '210000',
      unrealized_twd: '30000',
      invested_twd: '210000',
      missing_price_count: 1,
      has_pending: false,
    });

    const fam = await admin.get('/portfolio/family');
    expect(fam.status).toBe(200);
    expect(fam.body.users).toHaveLength(3);
    expect(fam.body.users.find((u: any) => u.user.id === 3).summary.market_value_twd).toBe('0');
    expect(fam.body.summary.market_value_twd).toBe('140000');
  });

  it('不存在的使用者 → 404', async () => {
    expect((await admin.get('/portfolio?user_id=99')).status).toBe(404);
  });
});

describe('設定', () => {
  it('只能改白名單設定，格式要對', async () => {
    expect((await admin.put('/settings', { tw_fee_discount: '0.28' })).body.settings.tw_fee_discount).toBe('0.28');
    expect((await admin.put('/settings', { evil: '1' })).status).toBe(400);
    expect((await admin.put('/settings', { tw_fee_min: 'abc' })).status).toBe(400);
  });
});
