import type { DecimalString, Transaction } from './index';
import { D, dec, type Dec, OUT_DP, out, ZERO } from './decimal';

/**
 * 持倉與損益計算（SPEC §4、§6）。純函式，前後端共用。
 *
 * 單位：一個持倉 = 一個帳戶 × 一檔標的，交易都是同一幣別（標的幣別）。
 *
 * 成本法：移動平均成本。
 *   - 買進／期初／再投入：數量 += q；原幣成本 += 金額（含費用）；TWD 成本 += 該筆 TWD 金額
 *   - 賣出：依目前平均成本（原幣、TWD 各自）沖銷，剩餘平均成本不變
 *   - 分割：數量 × 比例，成本不變
 *
 * 損益拆分：
 *   投資損益（原幣）＝ 市值原幣 − 成本原幣
 *   匯兌損益（TWD） ＝ 成本原幣 × 現匯率 − 成本 TWD   （＝ 成本原幣 ×（現匯率 − 成本加權匯率））
 *   總損益（TWD）   ＝ 市值 TWD − 成本 TWD           （＝ 投資損益 × 現匯率 + 匯兌損益）
 * 已實現同理，以賣出匯率取代現匯率。
 *
 * 報酬：
 *   價差報酬 ＝ 未實現總損益 + 已實現總損益
 *   含息總報酬 ＝ 價差報酬 + 累計股利（淨額，TWD）
 *   報酬率分母 ＝ 投入本金（期初 + 買進的 TWD 成本；股息再投入不算新本金）
 */

export type CalcTransaction = Pick<
  Transaction,
  | 'id'
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
  | 'status'
>;

export class PositionError extends Error {
  constructor(
    message: string,
    readonly transactionId: number,
  ) {
    super(message);
    this.name = 'PositionError';
  }
}

export interface ProfitSplit {
  /** 投資損益（原幣） */
  invest_orig: DecimalString;
  /** 匯兌損益（TWD） */
  fx_twd: DecimalString;
  /** 總損益（TWD） */
  total_twd: DecimalString;
}

export interface PositionState {
  quantity: DecimalString;
  /** 持有部位成本（原幣，含買進費用） */
  cost_orig: DecimalString;
  /** 持有部位成本（TWD） */
  cost_twd: DecimalString;
  /** 平均成本（原幣／單位）；數量為 0 時 null */
  avg_cost_orig: DecimalString | null;
  /** 成本加權匯率；成本為 0 時 null */
  avg_fx_rate: DecimalString | null;
  realized: ProfitSplit;
  /** 累計股利淨額（扣預扣稅、費用） */
  dividends: { orig: DecimalString; twd: DecimalString };
  /** 投入本金（期初 + 買進） */
  invested_orig: DecimalString;
  invested_twd: DecimalString;
  /** 是否含未確認（估算）交易 */
  has_pending: boolean;
}

export interface Valuation {
  market_value_orig: DecimalString | null;
  market_value_twd: DecimalString | null;
  unrealized: ProfitSplit | null;
  price_return_twd: DecimalString | null;
  total_return_twd: DecimalString | null;
  price_return_rate: DecimalString | null;
  total_return_rate: DecimalString | null;
}

const TYPE_ORDER: Record<CalcTransaction['type'], number> = {
  opening: 0,
  buy: 1,
  sell: 1,
  dividend_cash: 1,
  dividend_reinvest: 1,
  split: 1,
};

export function sortTransactions<T extends CalcTransaction>(txs: readonly T[]): T[] {
  return [...txs].sort(
    (a, b) =>
      a.trade_date.localeCompare(b.trade_date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id,
  );
}

function required(t: CalcTransaction, field: 'quantity' | 'split_ratio'): Dec {
  const v = t[field];
  if (v == null || v === '') throw new PositionError(`交易 #${t.id}（${t.type}）缺少 ${field}`, t.id);
  return D(v);
}

/** 交易的原幣總額：有 amount 用 amount，否則 quantity × price。 */
function grossAmount(t: CalcTransaction): Dec {
  if (t.amount != null && t.amount !== '') return D(t.amount);
  if (t.quantity != null && t.price != null) return D(t.quantity).times(t.price);
  throw new PositionError(`交易 #${t.id}（${t.type}）缺少 amount 或 quantity × price`, t.id);
}

/** 該筆的 TWD 金額：有 amount_twd 用它，否則原幣 × 匯率。 */
function toTwd(t: CalcTransaction, orig: Dec): Dec {
  return t.amount_twd != null && t.amount_twd !== '' ? D(t.amount_twd) : orig.times(t.fx_rate);
}

export function calcPosition(transactions: readonly CalcTransaction[]): PositionState {
  let qty = ZERO;
  let costOrig = ZERO;
  let costTwd = ZERO;
  let realizedInvest = ZERO;
  let realizedTotal = ZERO;
  let realizedFx = ZERO;
  let divOrig = ZERO;
  let divTwd = ZERO;
  let investedOrig = ZERO;
  let investedTwd = ZERO;
  let hasPending = false;

  for (const t of sortTransactions(transactions)) {
    if (t.status === 'pending') hasPending = true;
    const fee = dec(t.fee);
    const tax = dec(t.tax);
    const withholding = dec(t.withholding_tax);

    switch (t.type) {
      case 'opening':
      case 'buy': {
        const q = required(t, 'quantity');
        if (q.lte(0)) throw new PositionError(`交易 #${t.id} 數量必須大於 0`, t.id);
        // opening 的 amount 即期初總成本（已含費用）；buy 另加費用與稅
        const orig = t.type === 'opening' ? grossAmount(t) : grossAmount(t).plus(fee).plus(tax);
        const twd = toTwd(t, orig);
        qty = qty.plus(q);
        costOrig = costOrig.plus(orig);
        costTwd = costTwd.plus(twd);
        investedOrig = investedOrig.plus(orig);
        investedTwd = investedTwd.plus(twd);
        break;
      }
      case 'sell': {
        const q = required(t, 'quantity');
        if (q.lte(0)) throw new PositionError(`交易 #${t.id} 數量必須大於 0`, t.id);
        if (q.gt(qty)) {
          throw new PositionError(
            `交易 #${t.id}（${t.trade_date}）賣出 ${q} 超過當時持有 ${qty}`,
            t.id,
          );
        }
        const all = q.eq(qty);
        const outOrig = all ? costOrig : costOrig.times(q).div(qty);
        const outTwd = all ? costTwd : costTwd.times(q).div(qty);
        const proceedsOrig = grossAmount(t).minus(fee).minus(tax);
        const proceedsTwd = toTwd(t, proceedsOrig);
        const invest = proceedsOrig.minus(outOrig);
        const total = proceedsTwd.minus(outTwd);
        realizedInvest = realizedInvest.plus(invest);
        realizedTotal = realizedTotal.plus(total);
        realizedFx = realizedFx.plus(total.minus(invest.times(t.fx_rate)));
        qty = qty.minus(q);
        costOrig = all ? ZERO : costOrig.minus(outOrig);
        costTwd = all ? ZERO : costTwd.minus(outTwd);
        break;
      }
      case 'dividend_cash': {
        const net = grossAmount(t).minus(withholding).minus(fee);
        divOrig = divOrig.plus(net);
        divTwd = divTwd.plus(toTwd(t, net));
        break;
      }
      case 'dividend_reinvest': {
        const q = required(t, 'quantity');
        if (q.lte(0)) throw new PositionError(`交易 #${t.id} 數量必須大於 0`, t.id);
        const net = grossAmount(t).minus(withholding).minus(fee);
        const twd = toTwd(t, net);
        divOrig = divOrig.plus(net);
        divTwd = divTwd.plus(twd);
        qty = qty.plus(q);
        costOrig = costOrig.plus(net);
        costTwd = costTwd.plus(twd);
        break;
      }
      case 'split': {
        const ratio = required(t, 'split_ratio');
        if (ratio.lte(0)) throw new PositionError(`交易 #${t.id} 分割比例必須大於 0`, t.id);
        qty = qty.times(ratio);
        break;
      }
    }
  }

  return {
    quantity: out(qty, OUT_DP.quantity),
    cost_orig: out(costOrig, OUT_DP.money),
    cost_twd: out(costTwd, OUT_DP.money),
    avg_cost_orig: qty.gt(0) ? out(costOrig.div(qty), OUT_DP.money) : null,
    avg_fx_rate: costOrig.gt(0) ? out(costTwd.div(costOrig), OUT_DP.rate) : null,
    realized: {
      invest_orig: out(realizedInvest, OUT_DP.money),
      fx_twd: out(realizedFx, OUT_DP.money),
      total_twd: out(realizedTotal, OUT_DP.money),
    },
    dividends: { orig: out(divOrig, OUT_DP.money), twd: out(divTwd, OUT_DP.money) },
    invested_orig: out(investedOrig, OUT_DP.money),
    invested_twd: out(investedTwd, OUT_DP.money),
    has_pending: hasPending,
  };
}

function rate(num: Dec, den: Dec): DecimalString | null {
  return den.gt(0) ? out(num.div(den), OUT_DP.rate) : null;
}

/**
 * 以現價與現匯率評價持倉。price 為 null（沒有報價）時，市值與未實現為 null。
 * 數量為 0 時市值為 0（已出清部位仍可看已實現與股利）。
 */
export function valuePosition(
  p: PositionState,
  market: { price: DecimalString | null; fx_rate: DecimalString },
): Valuation {
  const qty = D(p.quantity);
  const realizedTotal = D(p.realized.total_twd);
  const dividends = D(p.dividends.twd);
  const invested = D(p.invested_twd);

  if (market.price == null && qty.gt(0)) {
    return {
      market_value_orig: null,
      market_value_twd: null,
      unrealized: null,
      price_return_twd: null,
      total_return_twd: null,
      price_return_rate: null,
      total_return_rate: null,
    };
  }

  const price = market.price == null ? ZERO : D(market.price);
  const fx = D(market.fx_rate);
  const costOrig = D(p.cost_orig);
  const costTwd = D(p.cost_twd);
  const mvOrig = qty.times(price);
  const mvTwd = mvOrig.times(fx);
  const uInvest = mvOrig.minus(costOrig);
  const uFx = costOrig.times(fx).minus(costTwd);
  const uTotal = mvTwd.minus(costTwd);
  const priceReturn = uTotal.plus(realizedTotal);
  const totalReturn = priceReturn.plus(dividends);

  return {
    market_value_orig: out(mvOrig, OUT_DP.money),
    market_value_twd: out(mvTwd, OUT_DP.money),
    unrealized: {
      invest_orig: out(uInvest, OUT_DP.money),
      fx_twd: out(uFx, OUT_DP.money),
      total_twd: out(uTotal, OUT_DP.money),
    },
    price_return_twd: out(priceReturn, OUT_DP.money),
    total_return_twd: out(totalReturn, OUT_DP.money),
    price_return_rate: rate(priceReturn, invested),
    total_return_rate: rate(totalReturn, invested),
  };
}


export interface PortfolioSummary {
  /** 有報價部位的市值合計（TWD） */
  market_value_twd: DecimalString;
  /** 持有部位成本合計（TWD） */
  cost_twd: DecimalString;
  unrealized_twd: DecimalString;
  realized_twd: DecimalString;
  dividends_twd: DecimalString;
  invested_twd: DecimalString;
  price_return_twd: DecimalString;
  total_return_twd: DecimalString;
  price_return_rate: DecimalString | null;
  total_return_rate: DecimalString | null;
  /** 有持股但缺報價或匯率的部位數；> 0 時市值與報酬不完整 */
  missing_price_count: number;
  has_pending: boolean;
}

/** 彙總多個持倉（全部換算 TWD）。缺報價的部位只計入已實現與股利。 */
export function summarizePositions(
  items: readonly { state: PositionState; valuation: Valuation | null }[],
): PortfolioSummary {
  let mv = ZERO;
  let cost = ZERO;
  let unrealized = ZERO;
  let realized = ZERO;
  let dividends = ZERO;
  let invested = ZERO;
  let missing = 0;
  let pending = false;

  for (const { state, valuation } of items) {
    realized = realized.plus(state.realized.total_twd);
    dividends = dividends.plus(state.dividends.twd);
    invested = invested.plus(state.invested_twd);
    cost = cost.plus(state.cost_twd);
    pending ||= state.has_pending;
    if (valuation?.market_value_twd != null && valuation.unrealized) {
      mv = mv.plus(valuation.market_value_twd);
      unrealized = unrealized.plus(valuation.unrealized.total_twd);
    } else if (D(state.quantity).gt(0)) {
      missing++;
    }
  }

  const priceReturn = unrealized.plus(realized);
  const totalReturn = priceReturn.plus(dividends);
  return {
    market_value_twd: out(mv, OUT_DP.money),
    cost_twd: out(cost, OUT_DP.money),
    unrealized_twd: out(unrealized, OUT_DP.money),
    realized_twd: out(realized, OUT_DP.money),
    dividends_twd: out(dividends, OUT_DP.money),
    invested_twd: out(invested, OUT_DP.money),
    price_return_twd: out(priceReturn, OUT_DP.money),
    total_return_twd: out(totalReturn, OUT_DP.money),
    price_return_rate: rate(priceReturn, invested),
    total_return_rate: rate(totalReturn, invested),
    missing_price_count: missing,
    has_pending: pending,
  };
}
