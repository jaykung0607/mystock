import {
  calcPosition,
  D,
  DEFAULT_FEE_SETTINGS,
  estimateTwFees,
  PositionError,
  type CalcTransaction,
  type Instrument,
  type Transaction,
  type TransactionType,
  type TwFeeSettings,
} from '@mystock/shared';
import { badRequest } from '../lib/http';
import type { TransactionCreateInput } from '../lib/schemas';

/** 寫入 transactions 表的欄位（不含 id、帳戶、標的、建立資訊）。 */
export type TxValues = Pick<
  Transaction,
  | 'type'
  | 'trade_date'
  | 'quantity'
  | 'price'
  | 'amount'
  | 'fee'
  | 'tax'
  | 'fx_rate'
  | 'amount_twd'
  | 'withholding_tax'
  | 'split_ratio'
  | 'note'
  | 'status'
>;

/** 正規化前的輸入：fee/tax 可能是 'auto' 或未填。 */
export type TxDraft = Omit<TransactionCreateInput, 'account_id' | 'instrument_id'>;

export interface NormalizeContext {
  instrument: Pick<Instrument, 'type' | 'symbol' | 'currency'>;
  feeSettings: TwFeeSettings;
  /** 查交易日（含）以前最近一筆台銀匯率；查無回 null */
  lookupFx: (currency: string, date: string) => Promise<string | null>;
}

const FIELD_RULES: Record<TransactionType, { required: (keyof TxDraft)[]; cleared: (keyof TxDraft)[] }> = {
  opening: { required: ['quantity', 'amount'], cleared: ['split_ratio'] },
  buy: { required: ['quantity', 'price'], cleared: ['split_ratio'] },
  sell: { required: ['quantity', 'price'], cleared: ['split_ratio'] },
  dividend_cash: { required: ['amount'], cleared: ['split_ratio'] },
  dividend_reinvest: { required: ['quantity'], cleared: ['split_ratio'] },
  split: {
    required: ['split_ratio'],
    cleared: ['quantity', 'price', 'amount', 'amount_twd', 'fee', 'tax', 'withholding_tax'],
  },
};

const TYPE_LABEL: Record<TransactionType, string> = {
  opening: '期初',
  buy: '買進',
  sell: '賣出',
  dividend_cash: '現金配息',
  dividend_reinvest: '股息再投入',
  split: '分割',
};

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * 依交易類型檢查必填欄位、清掉不適用的欄位、補上匯率與台股手續費。
 * fee/tax：'auto' 或（新增時）未填 → 台股買賣依 settings 估算，其他類型為 0。
 */
export async function normalizeTransaction(draft: TxDraft, ctx: NormalizeContext): Promise<TxValues> {
  const rules = FIELD_RULES[draft.type];
  const d: TxDraft = { ...draft };
  for (const f of rules.cleared) (d as Record<string, unknown>)[f] = undefined;
  for (const f of rules.required) {
    if (isEmpty(d[f])) badRequest(`${TYPE_LABEL[draft.type]}需要填 ${f}`);
  }
  if (draft.type === 'dividend_reinvest' && isEmpty(d.amount) && isEmpty(d.price)) {
    badRequest('股息再投入需要填 amount（再投入金額）或 price（單位淨值）');
  }
  for (const f of ['quantity', 'split_ratio'] as const) {
    if (!isEmpty(d[f]) && D(d[f]!).lte(0)) badRequest(`${f} 必須大於 0`);
  }

  // 匯率：TWD 計價一律 1；外幣未填則帶入台銀匯率
  let fxRate: string;
  if (ctx.instrument.currency === 'TWD' || draft.type === 'split') {
    fxRate = '1';
  } else if (!isEmpty(d.fx_rate)) {
    fxRate = d.fx_rate!;
    if (D(fxRate).lte(0)) badRequest('fx_rate 必須大於 0');
  } else {
    const found = await ctx.lookupFx(ctx.instrument.currency, draft.trade_date);
    if (!found) badRequest(`查無 ${draft.trade_date} 以前的 ${ctx.instrument.currency} 匯率，請手動填 fx_rate`);
    fxRate = found;
  }

  // 手續費／證交稅
  let fee = d.fee;
  let tax = d.tax;
  const autoEligible =
    ctx.instrument.type === 'tw_stock' && (draft.type === 'buy' || draft.type === 'sell');
  if (fee === 'auto' || tax === 'auto' || (autoEligible && (fee === undefined || tax === undefined))) {
    if (!autoEligible) {
      if (fee === 'auto' || tax === 'auto') badRequest('只有台股買進／賣出可自動計算手續費與稅');
    } else {
      const gross = isEmpty(d.amount) ? D(d.quantity!).times(d.price!) : D(d.amount!);
      const est = estimateTwFees({
        side: draft.type as 'buy' | 'sell',
        amount: gross.toString(),
        symbol: ctx.instrument.symbol,
        settings: ctx.feeSettings,
      });
      if (fee === 'auto' || fee === undefined) fee = est.fee;
      if (tax === 'auto' || tax === undefined) tax = est.tax;
    }
  }

  return {
    type: draft.type,
    trade_date: draft.trade_date,
    quantity: isEmpty(d.quantity) ? null : d.quantity!,
    price: isEmpty(d.price) ? null : d.price!,
    amount: isEmpty(d.amount) ? null : d.amount!,
    fee: isEmpty(fee) ? '0' : (fee as string),
    tax: isEmpty(tax) ? '0' : (tax as string),
    fx_rate: fxRate,
    amount_twd: isEmpty(d.amount_twd) ? null : d.amount_twd!,
    withholding_tax: isEmpty(d.withholding_tax) ? '0' : d.withholding_tax!,
    split_ratio: isEmpty(d.split_ratio) ? null : d.split_ratio!,
    note: isEmpty(d.note) ? null : d.note!,
    status: d.status ?? 'confirmed',
  };
}

/** 套用變更後重算持倉；會出錯（例如賣超過持有）就拒絕寫入。 */
export function assertPositionValid(txs: CalcTransaction[]): void {
  try {
    calcPosition(txs);
  } catch (err) {
    if (err instanceof PositionError) badRequest(err.message);
    throw err;
  }
}

export async function loadFeeSettings(db: D1Database): Promise<TwFeeSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'tw\\_%' ESCAPE '\\'")
    .all<{ key: string; value: string }>();
  const s: TwFeeSettings = { ...DEFAULT_FEE_SETTINGS };
  for (const { key, value } of results) {
    if (key in s) s[key as keyof TwFeeSettings] = value;
  }
  return s;
}

export function fxLookup(db: D1Database) {
  return async (currency: string, date: string) => {
    const row = await db
      .prepare('SELECT rate FROM fx_daily WHERE currency = ?1 AND date <= ?2 ORDER BY date DESC LIMIT 1')
      .bind(currency, date)
      .first<{ rate: string }>();
    return row?.rate ?? null;
  };
}

export const TX_CALC_COLUMNS =
  'id, type, trade_date, quantity, price, amount, fee, tax, fx_rate, amount_twd, withholding_tax, split_ratio, status';

export async function loadPositionTransactions(
  db: D1Database,
  accountId: number,
  instrumentId: number,
): Promise<CalcTransaction[]> {
  const { results } = await db
    .prepare(`SELECT ${TX_CALC_COLUMNS} FROM transactions WHERE account_id = ?1 AND instrument_id = ?2`)
    .bind(accountId, instrumentId)
    .all<CalcTransaction>();
  return results;
}
