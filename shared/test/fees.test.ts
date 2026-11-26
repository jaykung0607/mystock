import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_SETTINGS, estimateTwFees, isTwEtf } from '../src/fees';

const settings = { ...DEFAULT_FEE_SETTINGS, tw_fee_discount: '0.6' };

describe('台股手續費／證交稅估算', () => {
  it('買進：手續費 = 成交金額 × 費率 × 折扣，無條件捨去；無證交稅', () => {
    expect(estimateTwFees({ side: 'buy', amount: '100000', symbol: '2330', settings })).toEqual({ fee: '85', tax: '0' });
  });

  it('手續費最低 20 元', () => {
    expect(estimateTwFees({ side: 'buy', amount: '1000', symbol: '2330', settings }).fee).toBe('20');
  });

  it('賣出股票：證交稅 0.3%', () => {
    expect(estimateTwFees({ side: 'sell', amount: '100000', symbol: '2330', settings })).toEqual({ fee: '85', tax: '300' });
  });

  it('賣出 ETF：證交稅 0.1%', () => {
    expect(estimateTwFees({ side: 'sell', amount: '100000', symbol: '006208', settings }).tax).toBe('100');
  });

  it('ETF 判斷：00 開頭', () => {
    expect(isTwEtf('0050')).toBe(true);
    expect(isTwEtf('00878')).toBe(true);
    expect(isTwEtf('2330')).toBe(false);
  });

  it('成交金額為 0 → 不收費', () => {
    expect(estimateTwFees({ side: 'buy', amount: '0', symbol: '2330', settings })).toEqual({ fee: '0', tax: '0' });
  });
});
