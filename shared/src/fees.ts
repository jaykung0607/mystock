import type { DecimalString } from './index';
import { D, out } from './decimal';

/** settings 表中與台股費用相關的 key（見 migrations/0001_init.sql 預設值）。 */
export interface TwFeeSettings {
  tw_fee_rate: DecimalString;
  tw_fee_discount: DecimalString;
  tw_fee_min: DecimalString;
  tw_stock_tax_rate: DecimalString;
  tw_etf_tax_rate: DecimalString;
}

export const DEFAULT_FEE_SETTINGS: TwFeeSettings = {
  tw_fee_rate: '0.001425',
  tw_fee_discount: '1',
  tw_fee_min: '20',
  tw_stock_tax_rate: '0.003',
  tw_etf_tax_rate: '0.001',
};

/** 台股 ETF 代號以 00 開頭（例：0050、006208、00878）。 */
export function isTwEtf(symbol: string): boolean {
  return symbol.startsWith('00');
}

/**
 * 台股手續費與證交稅估算。
 * - 手續費 = 成交金額 × 費率 × 折扣，無條件捨去到元，最低 tw_fee_min
 * - 證交稅（只有賣出）= 成交金額 × 稅率，無條件捨去到元
 */
export function estimateTwFees(input: {
  side: 'buy' | 'sell';
  amount: DecimalString;
  symbol: string;
  settings: TwFeeSettings;
}): { fee: DecimalString; tax: DecimalString } {
  const amount = D(input.amount);
  if (amount.lte(0)) return { fee: '0', tax: '0' };
  const s = input.settings;
  const raw = amount.times(s.tw_fee_rate).times(s.tw_fee_discount).round(0, D.roundDown);
  const min = D(s.tw_fee_min);
  const fee = raw.lt(min) ? min : raw;
  const taxRate = isTwEtf(input.symbol) ? s.tw_etf_tax_rate : s.tw_stock_tax_rate;
  const tax = input.side === 'sell' ? amount.times(taxRate).round(0, D.roundDown) : D(0);
  return { fee: out(fee, 0), tax: out(tax, 0) };
}
