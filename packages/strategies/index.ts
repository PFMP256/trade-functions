import { PUBLIC_NFP_STRATEGY_ID, type Evaluation } from '../shared/src';
import { evaluateScenario as evaluateOriginal } from './btc-strategy-nfp-etf-v1/src';
import { evaluateBtcNfpObservedV1 } from './btc-strategy-nfp-observed-v1/src';

/** Dispatch by explicit identity. Each engine still validates its complete, strict configuration. */
export function evaluateScenario(snapshot: unknown, config: unknown, now: Date | string): Evaluation {
  const identity = config && typeof config === 'object' ? (config as Record<string, unknown>).strategyId : undefined;
  return identity === PUBLIC_NFP_STRATEGY_ID
    ? evaluateBtcNfpObservedV1(snapshot, config, now)
    : evaluateOriginal(snapshot, config, now);
}
