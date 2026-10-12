import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import { evaluateScenario } from '../../index';
import { evaluateBtcFundamentalTriggerV1 } from '../src';
import { anyScenarioConfigSchema, fundamentalTriggerScenarioConfigSchema, Snapshot } from '../../../shared/src';

describe('btc-fund-20261012-1631 scenario verification', () => {
  const scenarioRaw = JSON.parse(readFileSync(resolve('scenarios/btc-fund-20261012-1631.json'), 'utf8'));
  const config = fundamentalTriggerScenarioConfigSchema.parse(scenarioRaw);

  it('strictly validates scenario parameters and net RR at worst entry zone boundary', () => {
    expect(config.scenarioId).toBe('btc-fund-20261012-1631');
    expect(config.direction).toBe('SHORT');
    expect(config.validFromUtc).toBe('2026-10-12T16:31:00Z');
    expect(config.expiresAtUtc).toBe('2026-10-13T16:31:00Z');
    expect(config.referencePriceUsdt).toBe('82828.65');
    expect(config.entryZone).toEqual(['82415.00', '83245.00']);
    expect(config.takeProfitUsdt).toBe('79000.00');
    expect(config.stopLossUsdt).toBe('84600.00');

    // Worst entry for SHORT is minZone (82415.00)
    const worstEntry = new Decimal('82415.00');
    const tp = new Decimal('79000.00');
    const sl = new Decimal('84600.00');
    const grossProfit = worstEntry.minus(tp); // 3415.00
    const grossLoss = sl.minus(worstEntry);   // 2185.00
    const rr = grossProfit.div(grossLoss);     // 1.562929...

    expect(grossProfit.toFixed(2)).toBe('3415.00');
    expect(grossLoss.toFixed(2)).toBe('2185.00');
    expect(rr.toFixed(2)).toBe('1.56');
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
    const now = overrides.now ?? '2026-10-12T16:35:00.000Z';
    const obs = overrides.quoteObs ?? '2026-10-12T16:34:50.000Z';
    const fxObs = overrides.fxObs ?? obs;
    const ask = overrides.ask ?? '82830.00';
    const bid = overrides.bid ?? '82828.65';

    const prov = (url: string, o: string) => ({
      sourceId: 'test',
      sourceUrl: url,
      observedAt: o,
      publishedAt: null,
      firstSeenAt: o,
      availableAt: o,
      fetchedAt: o,
      revision: '1',
      verified: true,
      synthetic: false,
      conflicts: [],
    });

    const snapshot: Snapshot = {
      snapshotId: 'test-snapshot',
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
        value: overrides.fxVal ?? '1.0001',
        unit: 'USD_PER_USDT',
        period: 'instant',
        seriesId: 'USD_USDT',
        provenance: prov('https://api.kraken.com/0/public/Ticker', fxObs),
      },
      calendar: null,
      employment: null,
      consensus: null,
      treasury: [],
      etf: null,
      marketCalendar: null,
      klines: {
        minPrice: overrides.minKline ?? '82500.00',
        maxPrice: overrides.maxKline ?? '83100.00',
        fromUtc: '2026-10-12T16:31:00Z',
        toUtc: now,
        count: 5,
        provenance: prov('https://api.bybit.com/v5/market/kline', obs),
      },
      providerErrors: [],
    };

    return { snapshot, config, now };
  }

  it('triggers SHORT signal when bid is in entry zone and all conditions are met', () => {
    const { snapshot, config, now } = makeFixture({ bid: '82828.65', ask: '82830.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.reasonCodes).toContain('SIGNAL_CONFIRMED');
    expect(result.candidateEntryUsdt).toBe('82828.65');
    expect(result.risk).not.toBeNull();
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThanOrEqual(1.5);
  });

  it('triggers SHORT signal at worst entry zone boundary (82415.00) with RR >= 1.5', () => {
    const { snapshot, config, now } = makeFixture({ bid: '82415.00', ask: '82416.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.candidateEntryUsdt).toBe('82415.00');
    expect(result.risk).not.toBeNull();
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThanOrEqual(1.5);
  });

  it('triggers SHORT signal at best entry zone boundary (83245.00)', () => {
    const { snapshot, config, now } = makeFixture({ bid: '83245.00', ask: '83246.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('SHORT');
    expect(result.status).toBe('SIGNAL');
    expect(result.candidateEntryUsdt).toBe('83245.00');
    expect(result.risk).not.toBeNull();
    expect(result.risk?.valid).toBe(true);
    expect(Number(result.risk?.rewardRisk)).toBeGreaterThan(3.0);
  });

  it('returns WAITING_FOR_ENTRY_ZONE when bid is above upper entry zone boundary', () => {
    const { snapshot, config, now } = makeFixture({ bid: '83246.00', ask: '83247.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns WAITING_FOR_ENTRY_ZONE when bid is below lower entry zone boundary', () => {
    const { snapshot, config, now } = makeFixture({ bid: '82414.00', ask: '82415.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('WAITING_FOR_ENTRY_ZONE');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Stop Loss (84600.00)', () => {
    const { snapshot, config, now } = makeFixture({ maxKline: '84600.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns PRE_ENTRY_INVALIDATED when price touched Take Profit (79000.00)', () => {
    const { snapshot, config, now } = makeFixture({ minKline: '79000.00' });
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('PRE_ENTRY_INVALIDATED');
  });

  it('returns SCENARIO_EXPIRED when evaluation time is past expiresAtUtc', () => {
    const { snapshot, config } = makeFixture();
    const expiredNow = '2026-10-13T16:31:01.000Z';
    const result = evaluateScenario(snapshot, config, expiredNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('SCENARIO_EXPIRED');
  });

  it('returns SCENARIO_NOT_STARTED when evaluation time is before validFromUtc', () => {
    const { snapshot, config } = makeFixture();
    const beforeNow = '2026-10-12T16:30:59.000Z';
    const result = evaluateScenario(snapshot, config, beforeNow);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('WAITING');
    expect(result.reasonCodes).toContain('SCENARIO_NOT_STARTED');
  });

  it('returns STALE_DATA when quote is stale', () => {
    const { snapshot, config, now } = makeFixture({ quoteObs: '2026-10-12T16:33:00.000Z' }); // 120s old
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });

  it('returns STALE_DATA when FX is stale', () => {
    const { snapshot, config, now } = makeFixture({ fxObs: '2026-10-12T16:33:00.000Z' }); // 120s old
    const result = evaluateScenario(snapshot, config, now);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('STALE_DATA');
  });
});
