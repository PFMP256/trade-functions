import Decimal from 'decimal.js';
import { CostAssumptions, RiskResult, riskResultSchema } from '../../../shared/src';

export interface RiskInput {
  direction: 'LONG' | 'SHORT'; entryUsdt: string; usdPerUsdt: string; tickSize?: string;
  levels: { takeProfitUsd: string; stopLossUsd: string }; costs: CostAssumptions; minRewardRisk: string;
}

/** Entry already uses ask/bid (or the executor's worst permitted limit). No extra spread or entry slippage charge. */
export function calculateRisk(input: RiskInput): RiskResult {
  const entry = new Decimal(input.entryUsdt);
  const fx = new Decimal(input.usdPerUsdt);
  const isLong = input.direction === 'LONG';
  let tp = new Decimal(input.levels.takeProfitUsd).div(fx);
  let sl = new Decimal(input.levels.stopLossUsd).div(fx);
  if (input.tickSize) {
    const tick = new Decimal(input.tickSize);
    // TP rounds inward. Stop also rounds inward, never farther away to manufacture RR.
    tp = tp.div(tick).toDecimalPlaces(0, isLong ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL).mul(tick);
    sl = sl.div(tick).toDecimalPlaces(0, isLong ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR).mul(tick);
  }
  const grossProfit = isLong ? tp.minus(entry) : entry.minus(tp);
  const grossLoss = isLong ? entry.minus(sl) : sl.minus(entry);
  const entryFee = entry.mul(input.costs.entryFeeBps).div(10000);
  const exitBps = new Decimal(input.costs.exitFeeBps).plus(input.costs.exitSlippageBps);
  const costTp = entryFee.plus(tp.mul(exitBps).div(10000)).plus(input.costs.fundingToTpPerBtcUsdt);
  const costSl = entryFee.plus(sl.mul(exitBps).div(10000)).plus(input.costs.fundingToSlPerBtcUsdt);
  const netProfit = grossProfit.minus(costTp);
  const netLoss = grossLoss.plus(costSl);
  const rr = netLoss.gt(0) ? netProfit.div(netLoss) : null;
  const reasons: string[] = [];
  if (!grossProfit.gt(0) || !grossLoss.gt(0)) reasons.push('INVALID_TP_SL');
  if (!netProfit.gt(0) || !netLoss.gt(0) || !rr || rr.lt(Decimal.max('1.5',input.minRewardRisk))) reasons.push('RR_BELOW_MINIMUM');
  return riskResultSchema.parse({ valid: reasons.length === 0, reasonCodes: reasons,
    direction: input.direction, entryUsdt: entry.toFixed(), takeProfitUsdt: tp.toFixed(), stopLossUsdt: sl.toFixed(),
    grossProfitPerBtc: grossProfit.toFixed(), grossLossPerBtc: grossLoss.toFixed(),
    costToTpPerBtc: costTp.toFixed(), costToSlPerBtc: costSl.toFixed(),
    netProfitPerBtc: netProfit.toFixed(), netLossPerBtc: netLoss.toFixed(), rewardRisk: rr?.toFixed() ?? null,
    costs: input.costs,
  });
}
