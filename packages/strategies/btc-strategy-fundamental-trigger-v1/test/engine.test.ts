import { describe, it, expect } from 'vitest';
import { evaluateBtcFundamentalTriggerV1 } from '../src';
import { evaluateScenario } from '../../index';
import { makeFundamentalFixture, makeSyntheticProvenance } from './fixtures';
import { FUNDAMENTAL_TRIGGER_STRATEGY_ID } from '../../../shared/src';

describe('btc-strategy-fundamental-trigger-v1 engine', () => {
  it('emits LONG signal when ask is within valid entry zone and conditions are met', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.strategyId).toBe(FUNDAMENTAL_TRIGGER_STRATEGY_ID);
    expect(result.decision).toBe('LONG');
    expect(result.status).toBe('SIGNAL');
    expect(result.reasonCodes).toEqual(['SIGNAL_CONFIRMED']);
    expect(result.risk).not.toBeNull();
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThanOrEqual(1.5);
    expect(result.candidateEntryUsdt).toBe('85713.10');
  });

  it('emits SHORT signal when bid is within valid entry zone and conditions are met', () => {
    const { snapshot, config, now } = makeFundamentalFixture('SHORT');
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.strategyId).toBe(FUNDAMENTAL_TRIGGER_STRATEGY_ID);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.reasonCodes).toEqual(['SIGNAL_CONFIRMED']);
    expect(result.risk).not.toBeNull();
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThanOrEqual(1.5);
    expect(result.candidateEntryUsdt).toBe('85713.00');
  });

  it('returns WAITING_FOR_ENTRY_ZONE when LONG ask price is above upper zone boundary', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote!.ask = '86100.00';
    snapshot.quote!.last = '86100.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns WAITING_FOR_ENTRY_ZONE when LONG ask price is below lower zone boundary', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote!.bid = '85399.00';
    snapshot.quote!.ask = '85400.00';
    snapshot.quote!.last = '85400.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns WAITING_FOR_ENTRY_ZONE when SHORT bid price is outside zone', () => {
    const { snapshot, config, now } = makeFundamentalFixture('SHORT');
    snapshot.quote!.bid = '85200.00';
    snapshot.quote!.last = '85200.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Stop Loss in LONG scenario', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    // SL is 84800.00. Set klines minPrice to 84799.00
    snapshot.klines!.minPrice = '84799.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Take Profit in LONG scenario', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    // TP is 87800.00. Set klines maxPrice to 87805.00
    snapshot.klines!.maxPrice = '87805.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Stop Loss in SHORT scenario', () => {
    const { snapshot, config, now } = makeFundamentalFixture('SHORT');
    // SL is 86800.00. Set klines maxPrice to 86805.00
    snapshot.klines!.maxPrice = '86805.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Take Profit in SHORT scenario', () => {
    const { snapshot, config, now } = makeFundamentalFixture('SHORT');
    // TP is 82000.00. Set klines minPrice to 81950.00
    snapshot.klines!.minPrice = '81950.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns SCENARIO_EXPIRED when evaluation time is past expiresAtUtc', () => {
    const { snapshot, config } = makeFundamentalFixture('LONG');
    const expiredNow = '2026-10-06T20:19:00.000Z';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, expiredNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('SCENARIO_EXPIRED');
  });

  it('returns SCENARIO_NOT_STARTED when evaluation time is before validFromUtc', () => {
    const { snapshot, config } = makeFundamentalFixture('LONG');
    const earlyNow = '2026-10-05T20:17:00.000Z';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, earlyNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('SCENARIO_NOT_STARTED');
  });

  it('returns RR_BELOW_MINIMUM when reward risk is below required threshold', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    // Require RR of 3.0 when actual RR is ~1.56
    config.minRewardRisk = '3.0';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('RR_BELOW_MINIMUM');
  });

  it('returns STALE_DATA when quote is older than freshness threshold', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    // Set observedAt to 120 seconds before now (threshold is 60s)
    const staleTime = '2026-10-05T20:23:00.000Z';
    snapshot.quote!.provenance = makeSyntheticProvenance(staleTime, snapshot.quote!.provenance.sourceUrl);
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });

  it('returns STALE_DATA when FX is older than freshness threshold', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    const staleTime = '2026-10-05T20:23:00.000Z';
    snapshot.usdPerUsdt!.provenance = makeSyntheticProvenance(staleTime, snapshot.usdPerUsdt!.provenance.sourceUrl);
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });

  it('returns PRE_ENTRY_INVALIDATED when current quote directly touches SL', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote!.bid = '84800.00';
    snapshot.quote!.ask = '84801.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when current quote directly touches TP', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote!.bid = '87799.00';
    snapshot.quote!.ask = '87800.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns QUOTE_MISSING when snapshot quote is null', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote = null;
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('QUOTE_MISSING');
  });

  it('returns FX_MISSING when snapshot usdPerUsdt is null', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.usdPerUsdt = null;
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('FX_MISSING');
  });

  it('returns CROSSED_BOOK when bid exceeds ask', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.quote!.bid = '85800.00';
    snapshot.quote!.ask = '85700.00';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('CROSSED_BOOK');
  });

  it('returns DEMO_NOT_LIVE when live mode receives synthetic snapshot', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    config.tradingMode = 'live';
    config.environment = 'mainnet';
    snapshot.environment = 'mainnet';
    snapshot.synthetic = true;
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('DEMO_NOT_LIVE');
  });

  it('returns ENVIRONMENT_MISMATCH when snapshot and config environments differ', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    snapshot.environment = 'mainnet';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('ENVIRONMENT_MISMATCH');
  });

  it('dispatches properly through generic evaluateScenario', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    const result = evaluateScenario(snapshot, config, now);
    expect(result.strategyId).toBe(FUNDAMENTAL_TRIGGER_STRATEGY_ID);
    expect(result.decision).toBe('LONG');
  });

  it('correctly uses takeProfitUsdt and stopLossUsdt without FX distortion', () => {
    const { snapshot, config, now } = makeFundamentalFixture('LONG');
    config.takeProfitUsdt = '87800.00';
    config.stopLossUsdt = '84800.00';
    snapshot.usdPerUsdt!.value = '0.9990';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('LONG');
    expect(result.risk?.takeProfitUsdt).toBe('87800');
    expect(result.risk?.stopLossUsdt).toBe('84800');
  });

  it('rejects scenario config where entryZone min exceeds max', async () => {
    const { config } = makeFundamentalFixture('LONG');
    const raw = { ...config, entryZone: ['86000.00', '85000.00'] };
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(raw)).toThrow('Entry zone min must be <= max');
  });

  it('rejects scenario config where LONG TP is below upper zone or SL is above lower zone', async () => {
    const { config } = makeFundamentalFixture('LONG');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    const badTp = { ...config, takeProfitUsd: '85500.00', levels: undefined };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badTp)).toThrow('LONG takeProfit must be above upper entry zone boundary');
    const badSl = { ...config, stopLossUsd: '85600.00', levels: undefined };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badSl)).toThrow('LONG stopLoss must be below lower entry zone boundary');
  });

  it('rejects scenario config where net RR at worst entry zone boundary is below 1.5', async () => {
    const { config } = makeFundamentalFixture('LONG');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    // For LONG: entryZone is ['85455.96', '85970.24'], TP is 87800.00, SL is 84800.00.
    // If we widen entryZone max to 86800.00:
    // worstEntry = 86800.00, TP = 87800.00 (grossProfit = 1000), SL = 84800.00 (grossLoss = 2000), RR = 0.5 < 1.5.
    const badZoneConfig = { ...config, entryZone: ['85455.96', '86800.00'] };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badZoneConfig)).toThrow('Net reward-risk ratio at worst entry zone boundary');
  });

  it('rejects SHORT scenario config where net RR at worst entry zone boundary is below 1.5', async () => {
    const { config } = makeFundamentalFixture('SHORT');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    // For SHORT: entryZone is ['85400.00', '86000.00'], TP is 82000.00, SL is 86800.00.
    // Worst entry for SHORT is minZone (85400.00).
    // If minZone is lowered to 83000.00:
    // worstEntry = 83000.00, TP = 82000.00 (grossProfit = 1000), SL = 86800.00 (grossLoss = 3800), RR = 0.26 < 1.5.
    const badZoneConfig = { ...config, entryZone: ['83000.00', '86000.00'] };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badZoneConfig)).toThrow('Net reward-risk ratio at worst entry zone boundary');
  });

  it('rejects scenario config where minRewardRisk is configured below 1.5', async () => {
    const { config } = makeFundamentalFixture('LONG');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    const lowMinRrConfig = { ...config, minRewardRisk: '1.2' };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(lowMinRrConfig)).toThrow('RR must be at least 1.5');
  });

  it('rejects scenario config where gross RR is >= 1.5 but fees/costs drag net RR below 1.5', async () => {
    const { config } = makeFundamentalFixture('LONG');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    // Gross RR is ~1.5636. Adding 30 bps entry fee and 30 bps exit fee drags net RR below 1.5.
    const costlyConfig = {
      ...config,
      costs: {
        ...config.costs,
        entryFeeBps: '30',
        exitFeeBps: '30',
        exitSlippageBps: '10',
      },
    };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(costlyConfig)).toThrow('Net reward-risk ratio at worst entry zone boundary');
  });

  it('validates scenario config using takeProfitUsdt and stopLossUsdt directly', async () => {
    const { config } = makeFundamentalFixture('SHORT');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    const usdtConfig = {
      ...config,
      takeProfitUsd: undefined,
      stopLossUsd: undefined,
      takeProfitUsdt: '82000.00',
      stopLossUsdt: '86800.00',
    };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(usdtConfig)).not.toThrow();
  });

  it('rejects scenario config using takeProfitUsdt and stopLossUsdt when net RR is below 1.5', async () => {
    const { config } = makeFundamentalFixture('SHORT');
    const { fundamentalTriggerScenarioConfigSchema } = await import('../../../shared/src');
    const badUsdtConfig = {
      ...config,
      takeProfitUsd: undefined,
      stopLossUsd: undefined,
      takeProfitUsdt: '84000.00',
      stopLossUsdt: '86800.00',
    };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badUsdtConfig)).toThrow('Net reward-risk ratio at worst entry zone boundary');
  });
});

