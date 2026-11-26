/**
 * 前後端共用型別。對應 worker/migrations 的 D1 schema。
 *
 * 金額、數量、價格、匯率一律用十進位字串（DecimalString）傳遞與儲存，
 * 計算時再交給 decimal 函式庫，避免 float 累加誤差（SPEC §5）。
 */

/** 十進位數字字串，例："1234.5678"。不可為 float。 */
export type DecimalString = string;
/** ISO 日期 "YYYY-MM-DD"（台灣時間的交易日）。 */
export type DateString = string;
/** ISO 時間戳記（UTC）。 */
export type TimestampString = string;
/** ISO 4217 幣別，例："TWD"、"USD"。 */
export type CurrencyCode = string;

export const ROLES = ['admin', 'child'] as const;
export type Role = (typeof ROLES)[number];

export const INSTRUMENT_TYPES = ['tw_stock', 'us_stock', 'tw_fund', 'offshore_fund'] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const TRANSACTION_TYPES = [
  'opening',
  'buy',
  'sell',
  'dividend_cash',
  'dividend_reinvest',
  'split',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['confirmed', 'pending'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PRICE_SOURCES = ['auto', 'manual'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface User {
  id: number;
  email: string;
  display_name: string;
  role: Role;
  /** 預留：小孩「可輸入、需核准」旗標（v1 無 UI）。 */
  can_submit_pending: boolean;
  created_at: TimestampString;
}

export interface Account {
  id: number;
  user_id: number;
  name: string;
  broker: string | null;
  currency: CurrencyCode;
  created_at: TimestampString;
}

export interface Instrument {
  id: number;
  type: InstrumentType;
  symbol: string;
  name: string;
  currency: CurrencyCode;
  /** 基金級別（境外基金必填），其他為空字串。 */
  share_class: string;
  /** 抓價 adapter 名稱，例："twse"、"tpex"、"finnhub"、"manual"。 */
  data_source: string;
  /** 給 adapter 的識別碼（代號、基金代碼、ISIN 等）。 */
  source_key: string;
  created_at: TimestampString;
}

export interface Transaction {
  id: number;
  account_id: number;
  instrument_id: number;
  type: TransactionType;
  trade_date: DateString;
  /** 股數／單位數（可小數）。split 時為 null。 */
  quantity: DecimalString | null;
  /** 原幣單價。 */
  price: DecimalString | null;
  /** 原幣總額（不含費用）。opening 為期初總成本原幣。 */
  amount: DecimalString | null;
  fee: DecimalString;
  tax: DecimalString;
  /** 成交匯率（1 原幣 = ? TWD）。TWD 計價為 "1"。 */
  fx_rate: DecimalString;
  /** 選填：實際 TWD 金額（例：期初總成本 TWD）。有填時優先於 amount × fx_rate。 */
  amount_twd: DecimalString | null;
  /** 美股配息預扣稅（原幣）。 */
  withholding_tax: DecimalString;
  /** 分割比例：新股數 / 舊股數，例 1 拆 4 為 "4"。 */
  split_ratio: DecimalString | null;
  note: string | null;
  status: TransactionStatus;
  recurring_plan_id: number | null;
  created_by: number | null;
  created_at: TimestampString;
  updated_at: TimestampString;
}

export interface RecurringPlan {
  id: number;
  account_id: number;
  instrument_id: number;
  day_of_month: number;
  amount: DecimalString;
  currency: CurrencyCode;
  active: boolean;
  created_at: TimestampString;
}

export interface PriceDaily {
  instrument_id: number;
  date: DateString;
  close: DecimalString;
  source: PriceSource;
  updated_at: TimestampString;
}

export interface FxDaily {
  currency: CurrencyCode;
  date: DateString;
  rate: DecimalString;
  updated_at: TimestampString;
}

export interface PortfolioSnapshot {
  user_id: number;
  date: DateString;
  market_value_twd: DecimalString;
  cost_twd: DecimalString;
}

export interface WatchlistItem {
  user_id: number;
  instrument_id: number;
  added_at: TimestampString;
}

/** GET /api/me 回應。 */
export interface MeResponse {
  user: Pick<User, 'id' | 'email' | 'display_name' | 'role'>;
}

/** API 錯誤回應格式。 */
export interface ApiError {
  error: string;
  message: string;
}

/** GET /api/portfolio 的單一持倉（一個帳戶 × 一檔標的）。 */
export interface PortfolioPosition {
  account_id: number;
  account_name: string;
  instrument: Pick<Instrument, 'id' | 'type' | 'symbol' | 'name' | 'currency' | 'share_class'>;
  state: import('./portfolio').PositionState | null;
  valuation: import('./portfolio').Valuation | null;
  price: { close: DecimalString; date: DateString } | null;
  fx: { rate: DecimalString; date: DateString } | null;
  /** 計算錯誤（資料不一致，例如賣超過持有） */
  error?: string;
}

export interface PortfolioResponse {
  user_id: number;
  positions: PortfolioPosition[];
  summary: import('./portfolio').PortfolioSummary;
}

export interface FamilyPortfolioResponse {
  users: { user: Pick<User, 'id' | 'display_name' | 'role'>; summary: import('./portfolio').PortfolioSummary }[];
  summary: import('./portfolio').PortfolioSummary;
}

export * from './decimal';
export * from './fees';
export * from './portfolio';
