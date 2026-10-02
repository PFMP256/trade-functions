import Decimal from 'decimal.js';
import { calculateRisk } from '../../strategies/btc-strategy-nfp-etf-v1/src/risk';
import type { Book, ExecutionRequest, ExecutorSettings, Instrument, SizingPlan } from './types';

export class ExecutionBlocked extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ExecutionBlocked'; }
}
export function floorStep(value: Decimal.Value, step: Decimal.Value): Decimal { return new Decimal(value).div(step).floor().mul(step); }
export function ceilStep(value: Decimal.Value, step: Decimal.Value): Decimal { return new Decimal(value).div(step).ceil().mul(step); }

export function planEntry(request: ExecutionRequest, settings: ExecutorSettings, instrument: Instrument, book: Book, nowMs: number): SizingPlan {
  if (request.decision === 'NO_TRADE' || !request.levels || !request.costs || !request.usdPerUsdt) throw new ExecutionBlocked('EXECUTION_INPUT_INCOMPLETE');
  if (instrument.symbol !== 'BTCUSDT' || instrument.status !== 'Trading' || instrument.baseCoin !== 'BTC' || instrument.quoteCoin !== 'USDT' || instrument.settleCoin !== 'USDT' || instrument.contractType !== 'LinearPerpetual') throw new ExecutionBlocked('INSTRUMENT_INCOMPATIBLE');
  if (book.environment !== settings.environment || request.environment !== settings.environment) throw new ExecutionBlocked('ENVIRONMENT_MISMATCH');
  if (nowMs - book.observedAtMs > settings.quoteMaxAgeMs || book.observedAtMs > nowMs || new Decimal(book.bid).gt(book.ask)) throw new ExecutionBlocked('QUOTE_STALE_OR_INVALID');
  if (nowMs - Date.parse(request.usdPerUsdt.observedAtUtc) > settings.fxMaxAgeMs || Date.parse(request.usdPerUsdt.observedAtUtc) > nowMs || !request.usdPerUsdt.verified) throw new ExecutionBlocked('FX_STALE_OR_UNVERIFIED');
  const slippage = new Decimal(settings.entrySlippageBps).div(10000);
  const buy = request.decision === 'LONG';
  // Quantization cannot widen the maximum buy/minimum sell slippage boundary.
  const limit = buy ? floorStep(new Decimal(book.ask).mul(slippage.plus(1)), instrument.tickSize)
    : ceilStep(new Decimal(book.bid).mul(new Decimal(1).minus(slippage)), instrument.tickSize);
  if (limit.lt(instrument.minPrice) || limit.gt(instrument.maxPrice) || limit.lte(0)) throw new ExecutionBlocked('ENTRY_PRICE_OUT_OF_RANGE');
  const fx = new Decimal(request.usdPerUsdt.value);
  const target = new Decimal(settings.targetPositionNotionalUsd).div(fx);
  // A short may improve above its minimum sell price; ask is a conservative observable sizing price.
  const sizingPrice = Decimal.max(book.ask, limit);
  const qty = floorStep(target.div(sizingPrice), instrument.qtyStep);
  if (qty.lte(0) || qty.lt(instrument.minOrderQty) || qty.mul(limit).lt(instrument.minNotionalValue)) throw new ExecutionBlocked('SIZE_BELOW_EXCHANGE_MINIMUM');
  if (qty.gt(instrument.maxOrderQty)) throw new ExecutionBlocked('SIZE_ABOVE_EXCHANGE_MAXIMUM');
  const risk = calculateRisk({ direction: request.decision, entryUsdt: limit.toFixed(), usdPerUsdt: fx.toFixed(), tickSize: instrument.tickSize, levels: request.levels, costs: request.costs, minRewardRisk: Decimal.max(request.minRewardRisk, '1.5').toFixed() });
  if (!risk.valid || !risk.rewardRisk) throw new ExecutionBlocked(risk.reasonCodes[0] ?? 'RR_BELOW_MINIMUM');
  const nominalUsdt = qty.mul(sizingPrice);
  const margin = nominalUsdt.div(settings.leverage);
  const costReserve = qty.mul(Decimal.max(risk.costToTpPerBtc, risk.costToSlPerBtc));
  return {
    qty: qty.toFixed(), limitPrice: limit.toFixed(), sizingPrice: sizingPrice.toFixed(), targetNotionalUsdt: target.toFixed(),
    notionalPlannedUsd: nominalUsdt.mul(fx).toFixed(), takeProfitUsdt: risk.takeProfitUsdt, stopLossUsdt: risk.stopLossUsdt,
    rewardRisk: risk.rewardRisk, requiredFundsUsdt: margin.plus(costReserve).toFixed(),
  };
}
