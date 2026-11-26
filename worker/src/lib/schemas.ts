import { INSTRUMENT_TYPES, TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@mystock/shared';
import { z } from 'zod';

/** 非負十進位字串。也接受 JSON number（轉成字串），方便手動呼叫。 */
export const decimal = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .pipe(z.string().regex(/^\d+(\.\d+)?$/, '必須是非負的十進位數字'));

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), '日期不存在');

export const currency = z.string().regex(/^[A-Z]{3}$/, '幣別須為 3 個大寫英文字母，例 TWD、USD');

export const id = z.coerce.number().int().positive();

export const accountCreate = z.object({
  user_id: id,
  name: z.string().trim().min(1).max(100),
  broker: z.string().trim().max(100).nullish(),
  currency,
});

export const accountUpdate = z
  .object({
    name: z.string().trim().min(1).max(100),
    broker: z.string().trim().max(100).nullable(),
  })
  .partial();

/** 抓價來源：tw＝台股上市櫃收盤、yahoo／finnhub＝美股、manual＝手動輸入（基金淨值） */
export const DATA_SOURCES = ['tw', 'yahoo', 'finnhub', 'manual'] as const;
const dataSource = z.enum(DATA_SOURCES);

export const instrumentCreate = z.object({
  type: z.enum(INSTRUMENT_TYPES),
  symbol: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  currency,
  share_class: z.string().trim().max(100).default(''),
  /** 省略時依類型：tw_stock→tw、us_stock→yahoo、基金→manual */
  data_source: dataSource.optional(),
  source_key: z.string().trim().max(200).optional(),
});

export const instrumentUpdate = z
  .object({
    name: z.string().trim().min(1).max(200),
    share_class: z.string().trim().max(100),
    data_source: dataSource,
    source_key: z.string().trim().max(200),
  })
  .partial();

/** 'auto' = 依 settings 自動估算台股手續費／證交稅。 */
const feeInput = z.union([z.literal('auto'), decimal]);

const txFields = {
  type: z.enum(TRANSACTION_TYPES),
  trade_date: date,
  quantity: decimal.nullable(),
  price: decimal.nullable(),
  amount: decimal.nullable(),
  fee: feeInput,
  tax: feeInput,
  fx_rate: decimal.nullable(),
  amount_twd: decimal.nullable(),
  withholding_tax: decimal,
  split_ratio: decimal.nullable(),
  note: z.string().max(1000).nullable(),
  status: z.enum(TRANSACTION_STATUSES),
};

export const transactionCreate = z
  .object({ account_id: id, instrument_id: id, ...txFields })
  .partial()
  .required({ account_id: true, instrument_id: true, type: true, trade_date: true });

/** 不允許改帳戶或標的（要改請刪除重建）。 */
export const transactionUpdate = z.object(txFields).partial().strict();

export const transactionQuery = z.object({
  user_id: id.optional(),
  account_id: id.optional(),
  instrument_id: id.optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  from: date.optional(),
  to: date.optional(),
});

export type TransactionCreateInput = z.infer<typeof transactionCreate>;
export type TransactionUpdateInput = z.infer<typeof transactionUpdate>;
