import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import { evaluateScenario } from '../../index';
import { evaluateBtcFundamentalTriggerV1 } from '../src';
import { anyScenarioConfigSchema, fundamentalTriggerScenarioConfigSchema, Snapshot } from '../../../shared/src';

describe('btc-fund-20261011-1626 scenario verification', () => {
  const scenarioRaw = JSON.parse(readFileSync(resolve('scenarios/btc-fund-20261011-1626.json'), 'utf8'));
  const config = fundamentalTriggerScenarioConfigSchema.parse(scenarioRaw);

  it('strictly validates scenario parameters and net RR at worst entry zone boundary', () => {
    expect(config.scenarioId).toBe('btc-fund-20261011-1626');
    expect(config.direction).toBe('SHORT');
    expect(config.validFromUtc).toBe('2026-10-11T16:26:00Z');
    expect(config.expiresAtUtc).toBe('2026-10-12T16:26:00Z');
    expect(config.referencePriceUsdt).toBe('83776.45');
    expect(config.entryZone).toEqual(['83355.00', '84195.00']);
    expect(config.takeProfitUsdt).toBe('80000.00');
    expect(config.stopLossUsdt).toBe('84700.00');

    // Worst entry for SHORT is minZone (83355.00)
    const worstEntry = new Decimal('83355.00');
    const tp = new Decimal('80000.00');
    const sl = new Decimal('84700.00');
    const grossProfit = worstEntry.minus(tp); // 3355.00
    const grossLoss = sl.minus(worstEntry);   // 1345.00
    const rr = grossProfit.div(grossLoss);     // 2.49442379...

    expect(grossProfit.toFixed(2)).toBe('3355.00');
    expect(grossLoss.toFixed(2)).toBe('1345.00');
    expect(rr.toFixed(2)).toBe('2.49');
    expect(Number(rr.toFixed(4))).toBeGreaterThanOrEqual(1.5);
  });

  function makeFixture(overrides: {
    bid?: string;
    ask?: string;
    now?: string;
    quoteObs?: string;
    fxObs?: string;
    fxVal?: string;
    minKline?: string;
    maxKline?: string;
  } = {}) {
    const now = overrides.now ?? '2026-10-11T16:30:00.000Z';
    const obs = overrides.quoteObs ?? '2026-10-11T16:29:50.000Z';
    const fxObs = overrides.fxObs ?? obs;
    const ask = overrides.ask ?? '83778.00';
    const bid = overrides.bid ?? '83776.45';

    const prov = (url: string, o: string) => ({
      sourceId: 'test',
      sourceUrl: url,
      observedAt: o,
      publishedAt: null,
      firstSeenAt: o,
      availableAt: o,
      fetchedAt: o,
      revision: 'rev-1',
      verified: true,
      synthetic: false,
      conflicts: [],
    });

    const snapshot: Snapshot = {
      snapshotId: 'test-snap',
      environment: 'mainnet',
      synthetic: false,
      quote: {
        exchange: 'BYBIT',
        symbol: 'BTCUSDT',
        category: 'linear',
        quoteCurrency: 'USDT',
        environment: 'mainnet',
        bid,
        ask,
        last: bid,
        mark: bid,
        provenance: prov('https://api.bybit.com/v5/market/tickers', obs),
      },
      usdPerUsdt: {
        value: overrides.fxVal ?? '1.0000',
        unit: 'USD_PER_USDT',
        period: 'realtime',
        seriesId: 'USD_USDT',
        provenance: prov('https://api.kraken.com/0/public/Ticker', fxObs),
      },
      klines: {
        minPrice: overrides.minKline ?? '83500.00',
        maxPrice: overrides.maxKline ?? '83900.00',
        fromUtc: '2026-10-11T16:26:00.000Z',
        toUtc: now,
        count: 5,
        provenance: prov('https://api.bybit.com/v5/market/kline', obs),
      },
      calendar: null,
      employment: null,
      consensus: null,
      treasury: [],
      etf: null,
      marketCalendar: null,
      providerErrors: [],
    };

    return { snapshot, now };
  }

  it('emits SHORT SIGNAL when bid is inside valid entry zone', () => {
    const { snapshot, now } = makeFixture({ bid: '83776.45', ask: '83778.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.reasonCodes).toContain('SIGNAL_CONFIRMED');
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThanOrEqual(1.5);
  });

  it('returns WAITING_FOR_ENTRY_ZONE when bid is above upper zone boundary (84195.00)', () => {
    const { snapshot, now } = makeFixture({ bid: '84200.00', ask: '84201.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns WAITING_FOR_ENTRY_ZONE when bid is below lower zone boundary (83355.00)', () => {
    const { snapshot, now } = makeFixture({ bid: '83350.00', ask: '83351.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Stop Loss (84700.00) in klines', () => {
    const { snapshot, now } = makeFixture({ maxKline: '84700.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Take Profit (80000.00) in klines', () => {
    const { snapshot, now } = makeFixture({ minKline: '80000.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns SCENARIO_EXPIRED when evaluation is after expiresAtUtc (2026-10-12T16:26:00Z)', () => {
    const { snapshot } = makeFixture();
    const expiredNow = '2026-10-12T16:26:01.000Z';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, expiredNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('SCENARIO_EXPIRED');
  });

  it('returns SCENARIO_NOT_STARTED when evaluation is before validFromUtc (2026-10-11T16:26:00Z)', () => {
    const { snapshot } = makeFixture();
    const earlyNow = '2026-10-11T16:25:59.000Z';
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, earlyNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('SCENARIO_NOT_STARTED');
  });

  it('returns STALE_DATA when quote is older than 60s', () => {
    const { snapshot, now } = makeFixture({ quoteObs: '2026-10-11T16:28:59.000Z' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });

  it('returns STALE_DATA when FX is older than 60s', () => {
    const { snapshot, now } = makeFixture({ fxObs: '2026-10-11T16:28:59.000Z' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });

  it('returns CROSSED_BOOK when bid > ask', () => {
    const { snapshot, now } = makeFixture({ bid: '83780.00', ask: '83770.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('CROSSED_BOOK');
  });

  it('strictly validates that anyScenarioConfigSchema accepts this scenario', () => {
    const parsed = anyScenarioConfigSchema.parse(scenarioRaw);
    expect(parsed.scenarioId).toBe('btc-fund-20261011-1626');
  });

  it('strictly rejects the scenario schema if worst-entry net RR is below 1.5', () => {
    // If takeProfitUsdt is increased to 82000.00, worst entry profit is 83355 - 82000 = 1355
    // Loss is 84700 - 83355 = 1345. RR = 1355 / 1345 = 1.007 < 1.5
    const badConfig = { ...scenarioRaw, takeProfitUsdt: '82000.00', takeProfitUsd: '82000.00' };
    expect(() => fundamentalTriggerScenarioConfigSchema.parse(badConfig)).toThrow(
      'Net reward-risk ratio at worst entry zone boundary'
    );
  });

  it('triggers SHORT at exact lower entry zone boundary (83355.00) with RR >= 1.5', () => {
    const { snapshot, now } = makeFixture({ bid: '83355.00', ask: '83356.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeCloseTo(2.49, 1);
  });

  it('triggers SHORT at exact upper entry zone boundary (84195.00) with high RR', () => {
    const { snapshot, now } = makeFixture({ bid: '84195.00', ask: '84196.00' });
    const result = evaluateBtcFundamentalTriggerV1(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThan(8.0);
  });

  it('returns WAITING_FOR_ENTRY_ZONE just 0.01 outside zone boundaries', () => {
    const justBelow = makeFixture({ bid: '83354.99', ask: '83356.00' });
    const resBelow = evaluateBtcFundamentalTriggerV1(justBelow.snapshot, config, justBelow.now);
    expect(resBelow.decision).toBe('NO_TRADE');
    expect(resBelow.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');

    const justAbove = makeFixture({ bid: '84195.01', ask: '84196.00' });
    const resAbove = evaluateBtcFundamentalTriggerV1(justAbove.snapshot, config, justAbove.now);
    expect(resAbove.decision).toBe('NO_TRADE');
    expect(resAbove.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('dispatches properly through generic evaluateScenario', () => {
    const { snapshot, now } = makeFixture({ bid: '83776.45', ask: '83778.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.strategyId).toBe('btc-strategy-fundamental-trigger-v1');
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
  });
});

