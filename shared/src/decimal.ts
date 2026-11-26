import BigBase from 'big.js';

/**
 * 專用的 Big 建構子：設定獨立於其他使用 big.js 的程式。
 * - DP 20：除法精度（平均成本、加權匯率）
 * - 不使用科學記號輸出
 */
export const D = BigBase();
D.DP = 20;
D.RM = D.roundHalfUp;
D.NE = -40;
D.PE = 40;

export type Dec = InstanceType<typeof D>;

export const ZERO = D(0);
export const ONE = D(1);

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s);
}

export function dec(s: string | null | undefined, fallback: Dec = ZERO): Dec {
  return s == null || s === '' ? fallback : D(s);
}

/** 輸出位數：數量 8 位、金額 6 位、匯率與比率 6 位。 */
export const OUT_DP = { quantity: 8, money: 6, rate: 6 } as const;

/** 四捨五入後輸出成字串，去掉多餘的 0，且不會出現 "-0"。 */
export function out(x: Dec, dp: number): string {
  const r = x.round(dp, D.roundHalfUp);
  return r.eq(0) ? '0' : r.toString();
}
