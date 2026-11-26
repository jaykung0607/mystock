import { describe, expect, it } from 'vitest';
import { calcPosition, PositionError, summarizePositions, valuePosition, type CalcTransaction } from '../src/portfolio';

let nextId = 1;
function tx(t: Partial<CalcTransaction> & Pick<CalcTransaction, 'type' | 'trade_date'>): CalcTransaction {
  return {
    id: nextId++,
    quantity: null,
    price: null,
    amount: null,
    fee: '0',
    tax: '0',
    fx_rate: '1',
    amount_twd: null,
    withholding_tax: '0',
    split_ratio: null,
    status: 'confirmed',
    ...t,
  };
}

describe('移動平均成本（台股，TWD）', () => {
  const buys = [
    tx({ type: 'buy', trade_date: '2026-01-05', quantity: '1000', price: '50', fee: '20' }),
    tx({ type: 'buy', trade_date: '2026-02-05', quantity: '1000', price: '60', fee: '85' }),
  ];

  it('買進：成本含手續費，平均成本 = 總成本 / 股數', () => {
    const p = calcPosition(buys);
    expect(p.quantity).toBe('2000');
    expect(p.cost_orig).toBe('110105');
    expect(p.cost_twd).toBe('110105');
    expect(p.avg_cost_orig).toBe('55.0525');
    expect(p.avg_fx_rate).toBe('1');
    expect(p.invested_twd).toBe('110105');
  });

  it('部分賣出：以平均成本沖銷，剩餘平均成本不變', () => {
    const p = calcPosition([
      ...buys,
      tx({ type: 'sell', trade_date: '2026-03-02', quantity: '500', price: '70', fee: '49', tax: '105' }),
    ]);
    expect(p.quantity).toBe('1500');
    expect(p.cost_orig).toBe('82578.75');
    expect(p.avg_cost_orig).toBe('55.0525');
    // 實收 35000 − 49 − 105 = 34846；沖銷成本 55.0525 × 500 = 27526.25
    expect(p.realized.invest_orig).toBe('7319.75');
    expect(p.realized.fx_twd).toBe('0');
    expect(p.realized.total_twd).toBe('7319.75');
  });

  it('全部賣出：成本歸零、平均成本為 null、已實現累加', () => {
    const p = calcPosition([
      ...buys,
      tx({ type: 'sell', trade_date: '2026-03-02', quantity: '500', price: '70', fee: '49', tax: '105' }),
      tx({ type: 'sell', trade_date: '2026-04-01', quantity: '1500', price: '50' }),
    ]);
    expect(p.quantity).toBe('0');
    expect(p.cost_orig).toBe('0');
    expect(p.cost_twd).toBe('0');
    expect(p.avg_cost_orig).toBeNull();
    expect(p.avg_fx_rate).toBeNull();
    // 7319.75 + (75000 − 82578.75) = −259
    expect(p.realized.total_twd).toBe('-259');
  });

  it('賣超過持有股數 → PositionError', () => {
    expect(() =>
      calcPosition([...buys, tx({ type: 'sell', trade_date: '2026-03-02', quantity: '2001', price: '70' })]),
    ).toThrow(PositionError);
  });

  it('同日依序處理；輸入順序不影響結果（依日期、id 排序）', () => {
    const sell = tx({ type: 'sell', trade_date: '2026-03-02', quantity: '500', price: '70' });
    const a = calcPosition([...buys, sell]);
    const b = calcPosition([sell, buys[1]!, buys[0]!]);
    expect(b).toEqual(a);
  });

  it('零股、小數單位數', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '12.3456', price: '33.3', fee: '1' }),
      tx({ type: 'sell', trade_date: '2026-01-06', quantity: '0.3456', price: '40' }),
    ]);
    expect(p.quantity).toBe('12');
  });

  it('amount 可覆寫 quantity × price（例：基金申購金額）', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '3.3333', price: '30', amount: '100' }),
    ]);
    expect(p.cost_orig).toBe('100');
  });
});

describe('期初餘額', () => {
  it('opening：數量與期初總成本（原幣、TWD）', () => {
    const p = calcPosition([
      tx({ type: 'opening', trade_date: '2025-12-31', quantity: '10', amount: '1000', fx_rate: '31', amount_twd: '31234' }),
    ]);
    expect(p.quantity).toBe('10');
    expect(p.cost_orig).toBe('1000');
    expect(p.cost_twd).toBe('31234');
    expect(p.avg_fx_rate).toBe('31.234');
    expect(p.invested_twd).toBe('31234');
  });

  it('opening 沒填 amount_twd → amount × fx_rate', () => {
    const p = calcPosition([
      tx({ type: 'opening', trade_date: '2025-12-31', quantity: '10', amount: '1000', fx_rate: '31' }),
    ]);
    expect(p.cost_twd).toBe('31000');
  });

  it('同日 opening 一律排在最前面', () => {
    const sell = tx({ type: 'sell', trade_date: '2025-12-31', quantity: '5', price: '100' });
    const opening = tx({ type: 'opening', trade_date: '2025-12-31', quantity: '10', amount: '1000' });
    expect(() => calcPosition([sell, opening])).not.toThrow();
  });
});

describe('分割', () => {
  it('股數 × 比例，總成本不變、平均成本 ÷ 比例', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '10', price: '400', fx_rate: '30' }),
      tx({ type: 'split', trade_date: '2026-06-01', split_ratio: '4' }),
    ]);
    expect(p.quantity).toBe('40');
    expect(p.cost_orig).toBe('4000');
    expect(p.cost_twd).toBe('120000');
    expect(p.avg_cost_orig).toBe('100');
  });

  it('反分割（比例 < 1）', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '5' }),
      tx({ type: 'split', trade_date: '2026-06-01', split_ratio: '0.1' }),
    ]);
    expect(p.quantity).toBe('10');
    expect(p.avg_cost_orig).toBe('50');
  });

  it('分割後賣出用調整後的平均成本', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '10', price: '400' }),
      tx({ type: 'split', trade_date: '2026-06-01', split_ratio: '4' }),
      tx({ type: 'sell', trade_date: '2026-06-02', quantity: '20', price: '120' }),
    ]);
    expect(p.quantity).toBe('20');
    expect(p.realized.invest_orig).toBe('400'); // 2400 − 20 × 100
  });
});

describe('配息', () => {
  const base = tx({ type: 'buy', trade_date: '2026-01-05', quantity: '10', price: '100', fx_rate: '30' });

  it('現金配息：扣預扣稅與費用後計入股利，不影響成本', () => {
    const p = calcPosition([
      base,
      tx({ type: 'dividend_cash', trade_date: '2026-03-01', amount: '10', withholding_tax: '3', fx_rate: '32' }),
    ]);
    expect(p.dividends.orig).toBe('7');
    expect(p.dividends.twd).toBe('224');
    expect(p.cost_orig).toBe('1000');
    expect(p.quantity).toBe('10');
  });

  it('台股現金股利扣匯費／二代健保（fee）', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '1000', price: '100' }),
      tx({ type: 'dividend_cash', trade_date: '2026-07-01', amount: '3000', fee: '10' }),
    ]);
    expect(p.dividends.twd).toBe('2990');
  });

  it('股息再投入：計入股利，同時以再投入金額增加單位數與成本，不算新投入本金', () => {
    const p = calcPosition([
      base,
      tx({ type: 'dividend_reinvest', trade_date: '2026-03-01', quantity: '0.2', price: '100', fx_rate: '31' }),
    ]);
    expect(p.dividends.orig).toBe('20');
    expect(p.dividends.twd).toBe('620');
    expect(p.quantity).toBe('10.2');
    expect(p.cost_orig).toBe('1020');
    expect(p.cost_twd).toBe('30620');
    expect(p.invested_twd).toBe('30000');
  });

  it('股息再投入有預扣稅：成本只增加實際再投入金額', () => {
    const p = calcPosition([
      base,
      tx({ type: 'dividend_reinvest', trade_date: '2026-03-01', quantity: '0.14', amount: '20', withholding_tax: '6', fx_rate: '31' }),
    ]);
    expect(p.dividends.orig).toBe('14');
    expect(p.cost_orig).toBe('1014');
  });
});

describe('匯兌損益拆分（美股）', () => {
  const buys = [
    tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10', fx_rate: '30' }),
    tx({ type: 'buy', trade_date: '2026-02-05', quantity: '100', price: '12', fx_rate: '32' }),
  ];

  it('成本加權匯率', () => {
    const p = calcPosition(buys);
    expect(p.cost_orig).toBe('2200');
    expect(p.cost_twd).toBe('68400');
    expect(p.avg_fx_rate).toBe('31.090909');
  });

  it('未實現：投資損益（原幣）、匯兌損益（TWD）、總損益 = 投資 × 現匯率 + 匯兌', () => {
    const v = valuePosition(calcPosition(buys), { price: '15', fx_rate: '31.5' });
    expect(v.market_value_orig).toBe('3000');
    expect(v.market_value_twd).toBe('94500');
    expect(v.unrealized?.invest_orig).toBe('800');
    expect(v.unrealized?.fx_twd).toBe('900');
    expect(v.unrealized?.total_twd).toBe('26100');
  });

  it('已實現：賣出匯率拆分', () => {
    const p = calcPosition([
      ...buys,
      tx({ type: 'sell', trade_date: '2026-03-02', quantity: '100', price: '15', fx_rate: '33' }),
    ]);
    // 實收 1500 USD = 49500 TWD；沖銷成本 1100 USD / 34200 TWD
    expect(p.realized.invest_orig).toBe('400');
    expect(p.realized.fx_twd).toBe('2100');
    expect(p.realized.total_twd).toBe('15300');
    expect(p.cost_orig).toBe('1100');
    expect(p.cost_twd).toBe('34200');
  });

  it('賣出 amount_twd 覆寫：總損益以實收 TWD 計，匯兌 = 總 − 投資 × 賣出匯率', () => {
    const p = calcPosition([
      ...buys,
      tx({ type: 'sell', trade_date: '2026-03-02', quantity: '100', price: '15', fx_rate: '33', amount_twd: '49400' }),
    ]);
    expect(p.realized.total_twd).toBe('15200');
    expect(p.realized.fx_twd).toBe('2000');
  });
});

describe('報酬率', () => {
  it('價差報酬與含息總報酬分開', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10' }),
      tx({ type: 'dividend_cash', trade_date: '2026-03-01', amount: '50' }),
    ]);
    const v = valuePosition(p, { price: '11', fx_rate: '1' });
    expect(v.price_return_twd).toBe('100');
    expect(v.total_return_twd).toBe('150');
    expect(v.price_return_rate).toBe('0.1');
    expect(v.total_return_rate).toBe('0.15');
  });

  it('報酬含已實現', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10' }),
      tx({ type: 'sell', trade_date: '2026-02-01', quantity: '50', price: '12' }),
    ]);
    const v = valuePosition(p, { price: '10', fx_rate: '1' });
    expect(v.price_return_twd).toBe('100');
    expect(v.price_return_rate).toBe('0.1');
  });

  it('沒有報價 → 市值與未實現為 null，已實現仍算', () => {
    const p = calcPosition([tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10' })]);
    const v = valuePosition(p, { price: null, fx_rate: '1' });
    expect(v.market_value_twd).toBeNull();
    expect(v.unrealized).toBeNull();
    expect(v.price_return_twd).toBeNull();
  });
});

describe('待確認（pending）', () => {
  it('pending 交易以估算值計入，並標示 has_pending', () => {
    const p = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10' }),
      tx({ type: 'buy', trade_date: '2026-02-05', quantity: '90', price: '11.1', status: 'pending' }),
    ]);
    expect(p.quantity).toBe('190');
    expect(p.has_pending).toBe(true);
  });
});

describe('彙總（summarizePositions）', () => {
  it('合計 TWD；缺報價部位只計已實現與股利並計數', () => {
    const a = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '100', price: '10', fx_rate: '30' }),
    ]);
    const b = calcPosition([
      tx({ type: 'buy', trade_date: '2026-01-05', quantity: '1000', price: '50' }),
      tx({ type: 'sell', trade_date: '2026-02-05', quantity: '500', price: '60' }),
      tx({ type: 'dividend_cash', trade_date: '2026-03-05', amount: '1000' }),
    ]);
    const s = summarizePositions([
      { state: a, valuation: valuePosition(a, { price: '12', fx_rate: '31' }) },
      { state: b, valuation: valuePosition(b, { price: null, fx_rate: '1' }) },
    ]);
    expect(s.market_value_twd).toBe('37200');
    expect(s.unrealized_twd).toBe('7200');
    expect(s.realized_twd).toBe('5000');
    expect(s.dividends_twd).toBe('1000');
    expect(s.invested_twd).toBe('80000');
    expect(s.price_return_twd).toBe('12200');
    expect(s.total_return_twd).toBe('13200');
    expect(s.price_return_rate).toBe('0.1525');
    expect(s.missing_price_count).toBe(1);
  });
});
